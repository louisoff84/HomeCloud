import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";

async function freePort() {
  return new Promise((resolve,reject)=>{
    const server=net.createServer();
    server.once("error",reject);
    server.listen(0,"127.0.0.1",()=>{const port=server.address().port;server.close(()=>resolve(port));});
  });
}

test("HomeCloud account isolation, uploads, versions, sharing and trash", async t => {
  const dataDir=await mkdtemp(path.join(tmpdir(),"homecloud-test-"));
  const port=await freePort(), base="http://127.0.0.1:"+port;
  const child=spawn(process.execPath,["backend/server.js"],{
    cwd:process.cwd(),
    env:{...process.env,HOMECloud_DATA_DIR:dataDir,HOMECloud_PORT:String(port),HOMECloud_HOST:"127.0.0.1"},
    stdio:"ignore"
  });
  let cookie="";
  const request=async(route,options={})=>{
    const headers={...(options.headers||{})};
    if(cookie)headers.Cookie=cookie;
    const response=await fetch(base+route,{...options,headers});
    if(response.headers.get("set-cookie"))cookie=response.headers.get("set-cookie").split(";")[0];
    const type=response.headers.get("content-type")||"";
    const data=type.includes("application/json")?await response.json():Buffer.from(await response.arrayBuffer());
    return {response,data};
  };
  try {
    let ready=false;
    for(let i=0;i<80;i++){
      try{const response=await fetch(base+"/api/health");if(response.ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.equal(ready,true,"server should start");
    let result=await request("/api/auth/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"admin_user",password:"StrongPassword123!"})});
    assert.equal(result.response.status,200);
    result=await request("/api/files/upload?name=hello.txt",{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:"version one"});
    assert.equal(result.response.status,200);
    result=await request("/api/shares",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({path:"hello.txt",expiresInDays:7})});
    assert.equal(result.response.status,201);
    const shareUrl=result.data.share.url;
    const shared=await fetch(base+shareUrl);
    assert.equal(shared.status,200);
    assert.equal(await shared.text(),"version one");
    result=await request("/api/files/upload?name=hello.txt",{method:"POST",headers:{"Content-Type":"application/octet-stream"},body:"version two"});
    assert.equal(result.response.status,200);
    result=await request("/api/versions?path=hello.txt");
    assert.equal(result.data.versions.length,1);
    result=await request("/api/versions/"+result.data.versions[0].id,{method:"POST"});
    assert.equal(result.response.status,200);
    result=await request("/api/files/preview?path=hello.txt");
    assert.equal(await result.data.toString(),"version one");
    result=await request("/api/files?path=",{method:"DELETE"});
    assert.notEqual(result.response.status,200,"root must not be deletable");
    result=await request("/api/files?path=hello.txt",{method:"DELETE"});
    assert.equal(result.response.status,200);
    result=await request("/api/trash");
    assert.equal(result.data.items.length,1);
    result=await request("/api/trash/"+result.data.items[0].id,{method:"POST"});
    assert.equal(result.response.status,200);
    result=await request("/api/files?path=");
    assert.equal(result.data.files.some(file=>file.name==="hello.txt"),true);
    result=await request("/api/admin/users",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"second_user",password:"AnotherStrongPassword123!"})});
    assert.equal(result.response.status,201);
    const secondCookie=cookie;
    const secondLogin=await fetch(base+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"second_user",password:"AnotherStrongPassword123!"})});
    assert.equal(secondLogin.status,200);
    const secondSession=secondLogin.headers.get("set-cookie").split(";")[0];
    const isolated=await fetch(base+"/api/files/all",{headers:{Cookie:secondSession}});
    assert.equal(isolated.status,200);
    assert.equal((await isolated.json()).files.length,0,"second user must not see admin files");
    const password=await request("/api/account/password",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({currentPassword:"StrongPassword123!",newPassword:"NewStrongPassword123!"})});
    assert.equal(password.response.status,200);
    const newLogin=await fetch(base+"/api/auth/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"admin_user",password:"NewStrongPassword123!"})});
    assert.equal(newLogin.status,200);
    assert.ok(secondCookie);
  } finally {
    if(child.exitCode===null){const exited=new Promise(resolve=>child.once("exit",resolve));child.kill("SIGTERM");await exited;}
    await rm(dataDir,{recursive:true,force:true});
  }
});
