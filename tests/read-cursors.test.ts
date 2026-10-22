import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadCursors, newerStatus } from '../web/read-cursors.js';
const storage = () => { const data = new Map<string,string>(); return {getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>{data.set(k,v);}}; };
test('independent readers, concurrent new event, reload and replacement identity', () => {
 const aStore=storage(),a=new ReadCursors(aStore),b=new ReadCursors(storage());
 const first={instance:'one',version:10,eventSeq:10,unread:true};
 assert(a.unread('s',first)); a.read('s',first); assert(!a.unread('s',first));assert(b.unread('s',first));
 const second={...first,version:11,eventSeq:11}; a.read('s',first);assert(a.unread('s',second));
 a.read('s',second);a.read('s',first);assert(!new ReadCursors(aStore).unread('s',second));
 assert(a.unread('s',{...first,instance:'replacement'}));assert(!newerStatus(second,first));
});
