import { EventEmitter } from 'node:events'
import { BaileysProvider } from '../src/bailey'
import { makeWASocketOther } from '../src/baileyWrapper'

jest.mock('@builderbot/bot', () => ({
  ProviderClass: class extends require('node:events').EventEmitter {
    server = { use: jest.fn().mockReturnThis(), get: jest.fn().mockReturnThis() }
    idBotName = 'bot'
    listenOnEvents = jest.fn()
  },
  utils: { cleanImage: jest.fn(), delay: jest.fn(async () => undefined) },
}))
jest.mock('../src/baileyWrapper', () => ({
  makeWASocketOther: jest.fn(),
  makeCacheableSignalKeyStore: jest.fn((keys) => keys),
  useMultiFileAuthState: jest.fn(async () => ({ state: { creds: {}, keys: {} }, saveCreds: jest.fn() })),
  DisconnectReason: { loggedOut: 401, connectionClosed: 428, connectionLost: 408, connectionReplaced: 440, timedOut: 408, badSession: 500, restartRequired: 515 },
  proto: { Message: { create: jest.fn() } },
}))
jest.mock('../src/releaseTmp', () => ({ releaseTmp: jest.fn(async () => undefined) }))
jest.mock('wa-sticker-formatter', () => ({ Sticker: jest.fn() }))
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  createWriteStream: jest.fn(() => new (require('node:stream').Writable)({ write(_c: any, _e: any, done: any) { done() } })),
  createReadStream: jest.fn(() => { throw new Error('ENOENT: no QR exists') }),
}))


const message=()=>({key:{id:'incoming-1',remoteJid:'5491100000000@s.whatsapp.net',fromMe:false},messageTimestamp:1788598800,message:{conversation:'hello'}})
function harness(){jest.spyOn(BaileysProvider.prototype as any,'setupCleanupHandlers').mockImplementation(()=>undefined);jest.spyOn(BaileysProvider.prototype as any,'setupPeriodicCleanup').mockImplementation(()=>undefined);const p:any=new BaileysProvider({name:'incoming-gate'});const upsert=p.busEvents().find((x:any)=>x.event==='messages.upsert').func;const received=jest.fn();p.on('message',received);return {p,received,upsert:()=>upsert({type:'notify',messages:[message()]})}}
afterEach(()=>jest.restoreAllMocks())
test('awaits admission before dedup and emission, then rechecks concurrent duplicate',async()=>{
 const h=harness();let release:any;const wait=new Promise<boolean>(r=>release=r);const gate=jest.fn(async(_payload:any,dispatch:()=>boolean)=>await wait?dispatch():false);h.p.setLifecycleIncomingGate?.(gate)
 const first=h.upsert(),second=h.upsert();await Promise.resolve();expect(h.received).not.toHaveBeenCalled();expect(h.p.idsDuplicates).toHaveLength(0)
 release(true);await Promise.all([first,second]);expect(h.received).toHaveBeenCalledTimes(1);expect(gate).toHaveBeenCalledTimes(2)
})
test.each(['excluded','deferred'])('%s does not emit or poison dedup; later permitted retry is still possible',async()=>{
 const h=harness();let allowed=false;const gate=jest.fn(async(_payload:any,dispatch:()=>boolean)=>allowed?dispatch():false);h.p.setLifecycleIncomingGate?.(gate)
 await h.upsert();expect(h.received).not.toHaveBeenCalled();expect(h.p.idsDuplicates).toHaveLength(0)
 allowed=true;await h.upsert();expect(h.received).toHaveBeenCalledTimes(1)
})
test('failed admission or durable retention rejects upstream without dedup or false ACK',async()=>{
 const h=harness();h.p.setLifecycleIncomingGate?.(async()=>{throw new Error('durability unavailable')})
 await expect(h.upsert()).rejects.toThrow('durability unavailable');expect(h.received).not.toHaveBeenCalled();expect(h.p.idsDuplicates).toHaveLength(0)
})
test('legacy without enrollment hook preserves direct message dispatch',async()=>{const h=harness();await h.upsert();expect(h.received).toHaveBeenCalledTimes(1)})
test('private async gate owns the synchronous dedup-and-emission callback',async()=>{
 const h=harness();const gate=jest.fn(async(_payload:any,dispatch?:()=>boolean)=>dispatch?dispatch():false);h.p.setLifecycleIncomingGate?.(gate)
 await h.upsert();expect(gate).toHaveBeenCalledWith(expect.objectContaining({key:expect.objectContaining({id:'incoming-1'})}),expect.any(Function));expect(h.received).toHaveBeenCalledTimes(1)
})
test('socket stop during awaited admission prevents the synchronous dedup callback',async()=>{
 const h=harness();let release:any;const wait=new Promise<void>(resolve=>release=resolve)
 h.p.setLifecycleIncomingGate(async(_payload:any,dispatch:()=>boolean)=>{await wait;return dispatch()})
 const pending=h.upsert();h.p.lifecycleStopped=true;release();await pending
 expect(h.received).not.toHaveBeenCalled();expect(h.p.idsDuplicates).toHaveLength(0)
})
