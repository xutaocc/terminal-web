import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { execFile, execFileSync } from '../src/background-process.js';

test('background execution preserves arguments, output, cwd and env while hiding the console', async t => {
  const native = childProcess.execFile;
  let hidden: unknown;
  t.mock.method(childProcess, 'execFile', (...args: any[]) => {
    hidden = args[2].windowsHide;
    return (native as any)(...args);
  });
  const value = await new Promise<{out:string;err:string}>((resolve,reject) => {
    const child = execFile(process.execPath, ['-e', 'console.log(JSON.stringify([process.argv[1],process.cwd(),process.env.TW_TEST_VALUE]));console.error("stderr-ok")', '空 格\n$literal'],
      {cwd:process.cwd(),env:{...process.env,TW_TEST_VALUE:'kept'},windowsHide:false,timeout:5000,maxBuffer:4096},
      (error,out,err) => error ? reject(error) : resolve({out,err}));
    assert.ok(child.pid);
  });
  assert.equal(hidden,true);
  assert.deepEqual(JSON.parse(value.out),['空 格\n$literal',process.cwd(),'kept']);
  assert.equal(value.err.trim(),'stderr-ok');
});

test('callback-only form, nonzero exit and timeout retain native behavior', async () => {
  const out=await new Promise<string>((resolve,reject)=>execFile(process.execPath,['-e','console.log("ok")'],(e,out)=>e?reject(e):resolve(out)));
  assert.equal(out.trim(),'ok');
  const exit=await new Promise<any>(resolve=>execFile(process.execPath,['-e','process.stderr.write("failed");process.exit(7)'],(e,out,err)=>resolve({e,out,err})));
  assert.equal(exit.e.code,7);assert.equal(exit.err,'failed');
  const timeout=await new Promise<any>(resolve=>execFile(process.execPath,['-e','setTimeout(()=>{},10000)'],{timeout:100},e=>resolve(e)));
  assert.equal(timeout.killed,true);
});

test('synchronous background execution preserves output and failures', t => {
  const native=childProcess.execFileSync;let hidden:unknown;
  t.mock.method(childProcess,'execFileSync',(...args:any[])=>{hidden=args[2].windowsHide;return (native as any)(...args);});
  assert.equal(execFileSync(process.execPath,['-e','process.stdout.write("version")'],{encoding:'utf8'}),'version');
  assert.equal(hidden,true);
  assert.throws(()=>execFileSync(process.execPath,['-e','process.exit(9)'],{stdio:'ignore'}));
});
