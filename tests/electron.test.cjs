const fs=require('fs'),vm=require('vm'),assert=require('assert/strict'),{EventEmitter}=require('events');
const nativePath=require('node:path');
const repo=nativePath.resolve(__dirname, '..');
const portablePath=value=>value.replaceAll('\\','/');
async function mainHarness(platform='darwin',assertion='',host='',hostError=null,{packaged=false,env={},diagnosticsError=null,trayError=null,deferProbes=false,instanceLock=true,linuxOutput='Active=yes\nLockedHint=no\n',linuxError=null,asyncFullscreen=false}={}){
 const warnings=[];const testConsole={...console,warn:(...args)=>warnings.push(args)};
 const handlers={},listeners={},calls=[],windows=[],diagnosticFiles=new Map(),diagnosticWrites=[],power=new EventEmitter(),execCalls=[],pendingProbes=[],notifications=[];let state='active',trayMenu,tray,now=100000,sessionOutput=linuxOutput,sessionError=linuxError;
 const Clock=class extends Date{static now(){return now}};
 const diagnosticFs={mkdirSync(){},writeFileSync(file,contents,options){if(diagnosticsError)throw diagnosticsError;diagnosticWrites.push({file,options});diagnosticFiles.set(file,contents)},renameSync(from,to){diagnosticFiles.set(to,diagnosticFiles.get(from));diagnosticFiles.delete(from)}};
 power.getSystemIdleTime=()=>0;power.getSystemIdleState=()=>state;
 let displays=[{id:1,workArea:{x:0,y:0,width:1920,height:1040}},{id:2,workArea:{x:1920,y:0,width:1920,height:1040}}];
 const screen={getAllDisplays:()=>displays,getPrimaryDisplay:()=>displays[0],getDisplayMatching:bounds=>displays.find(display=>bounds.x<display.workArea.x+display.workArea.width&&bounds.x+bounds.width>display.workArea.x&&bounds.y<display.workArea.y+display.workArea.height&&bounds.y+bounds.height>display.workArea.y)||displays[0]};
 const BrowserWindow=function(options){
  const window=new EventEmitter();window.options=options;window.loading=true;window.destroyed=false;window.hidden=false;window.minimized=false;
  window.webContents=new EventEmitter();window.webContents.mainFrame={};window.webContents.send=(...args)=>calls.push(['send',...args]);window.webContents.isLoadingMainFrame=()=>window.loading;
  window.bounds={x:20,y:40,width:1120,height:780};
  window.isMinimized=()=>window.minimized;window.isDestroyed=()=>window.destroyed;window.isVisible=()=>!window.hidden&&!window.minimized&&!window.destroyed;window.isAlwaysOnTop=()=>window.alwaysOnTop||false;window.isMaximized=()=>window.maximized||false;window.getBounds=()=>({...window.bounds});window.getNormalBounds=()=>({... (window.normalBounds||window.bounds)});window.isFullScreen=()=>window.fullscreen||false;
  for(const name of ['setIcon','setTitle','restore','show','showInactive','focus','flashFrame','setAlwaysOnTop','loadURL','loadFile','hide','minimize','maximize','unmaximize','setBounds'])window[name]=(...args)=>{calls.push([name,...args]);if(name==='hide')window.hidden=true;if(['show','showInactive'].includes(name))window.hidden=false;if(name==='restore')window.minimized=false;if(name==='minimize')window.minimized=true;if(name==='maximize')window.maximized=true;if(name==='unmaximize')window.maximized=false;if(name==='setBounds'){window.bounds={...args[0]};window.normalBounds={...args[0]}}if(name==='setAlwaysOnTop')window.alwaysOnTop=args[0]};
  window.setFullScreen=flag=>{calls.push(['setFullScreen',flag]);if(asyncFullscreen&&platform==='darwin'&&!flag&&window.fullscreen)window.pendingFullscreenExit=true;else window.fullscreen=flag};
  window.finishFullscreenExit=()=>{window.pendingFullscreenExit=false;window.fullscreen=false;window.emit('leave-full-screen')};
  window.finishLoad=()=>{window.loading=false;window.webContents.emit('did-finish-load')};
  window.destroy=()=>{window.destroyed=true;window.emit('closed')};
  window.close=()=>{let prevented=false;window.emit('close',{preventDefault(){prevented=true}});if(!prevented)window.destroy();return prevented};
  windows.push(window);return window;
 };BrowserWindow.getAllWindows=()=>windows.filter(window=>!window.destroyed);
 const appPaths={appData:'/virtual',userData:'/virtual/blincho',sessionData:'/virtual/blincho'};
 const app={dock:{setIcon:icon=>calls.push(['dockIcon',icon])},getPreferredSystemLanguages:()=>['ru'],isPackaged:packaged,requestSingleInstanceLock:()=>{calls.push(['requestSingleInstanceLock']);return instanceLock},on:(name,cb)=>listeners[name]=cb,quit(){calls.push(['quit']);listeners['before-quit']?.();for(const window of BrowserWindow.getAllWindows())window.close()},whenReady:()=>{calls.push(['whenReady']);return Promise.resolve()},getAppPath:()=>repo,getPath:name=>appPaths[name],setName:name=>calls.push(['setName',name]),setPath:(name,value)=>{calls.push(['setPath',name,value]);appPaths[name]=value},setAppUserModelId:id=>calls.push(['setAppUserModelId',id]),setDesktopName:name=>calls.push(['setDesktopName',name])};
 const ipcMain={on:(name,cb)=>handlers[name]=cb,handle:(name,cb)=>handlers[name]=cb};
 const nativeImage={createFromBitmap:(bitmap,options)=>({path:'camera-active',bitmap,options,setTemplateImage:flag=>calls.push(['setTemplateImage',flag])}),createFromPath:file=>{calls.push(['createFromPath',file]);return{path:file,width:20,height:20,isEmpty:()=>false,resize(options){this.width=options.width;this.height=options.height;calls.push(['resize',options]);return this},toBitmap(){return Buffer.alloc(this.width*this.height*4,17)},setTemplateImage:flag=>calls.push(['setTemplateImage',flag])}}};
 const execFile=(file,args,options,cb)=>{execCalls.push({file,args,options});const sampledOutput=sessionOutput,sampledError=sessionError;const finish=()=>file==='loginctl'?cb(sampledError,sampledOutput):file.includes('pmset')?cb(null,assertion):cb(hostError,host);if(deferProbes)pendingProbes.push(finish);else finish()};
 function Notification(options){const notification=new EventEmitter();notification.options=options;notification.show=()=>{};notifications.push(notification);return notification}Notification.isSupported=()=>true;
 vm.runInNewContext(fs.readFileSync(repo+'/electron/main.cjs','utf8'),{require:name=>name==='electron'?{app,BrowserWindow,ipcMain,Notification,Tray:function(icon){if(trayError)throw trayError;tray=new EventEmitter();tray.icon=icon;tray.setImage=icon=>{tray.icon=icon;calls.push(['trayIcon',icon.path])};tray.setToolTip=text=>tray.tooltip=text;tray.setContextMenu=menu=>trayMenu=menu;return tray},Menu:{buildFromTemplate:x=>x,setApplicationMenu:menu=>calls.push(['setApplicationMenu',menu])},nativeImage,powerMonitor:power,screen}:name==='./updater.cjs'?require(repo+'/electron/updater.cjs'):name==='./locales.cjs'?require(repo+'/electron/locales.cjs'):name==='./linuxSession.cjs'?require(repo+'/electron/linuxSession.cjs'):name==='child_process'?{execFile}:name==='node:perf_hooks'?{performance:{now:()=>now}}:name==='fs'?diagnosticFs:require(name),process:{platform,argv:['electron','.','--dev'],env},Date:Clock,__dirname:repo+'/electron',console:testConsole});
 await Promise.resolve();return{handlers,calls,execCalls,pendingProbes,notifications,advanceTime:ms=>now+=ms,get tray(){return tray},get window(){return windows.at(-1)},windows,app,listeners,get trayMenu(){return trayMenu},get diagnostics(){const value=diagnosticFiles.get(nativePath.join('/virtual','myeyes','runtime-diagnostics.json'));return value?JSON.parse(value):null},diagnosticWrites,power,warnings,setState:value=>state=value,setDisplays:value=>displays=value,setLinuxSession:(output,error=null)=>{sessionOutput=output;sessionError=error}};
}
(async()=>{
 const identity=await mainHarness('darwin','','',null,{packaged:true});
 assert.equal(portablePath(identity.app.getPath('userData')),'/virtual/myeyes','rename must preserve the original user profile');
 assert.equal(portablePath(identity.app.getPath('sessionData')),'/virtual/myeyes','Chromium localStorage must stay in the original profile');
 const pathOverrides=identity.calls.map((call,index)=>({call,index})).filter(({call})=>call[0]==='setPath');
 assert.equal(pathOverrides.length,2);
 for(const {index} of pathOverrides)for(const boundary of ['requestSingleInstanceLock','whenReady'])assert(index<identity.calls.findIndex(([name])=>name===boundary),`profile configured before ${boundary}`);
 assert(identity.calls.some(([action,name])=>action==='setName'&&name==='Blincho'));
 assert.equal(identity.window.options.title,'Blincho: Перерывы от экрана');
 assert(identity.trayMenu.some(item=>item.label==='Показать Blincho'));
 const h=await mainHarness('darwin','PreventUserIdleDisplaySleep 0\npid 3(Zoom): PreventUserIdleSystemSleep named: "meeting"');assert.equal((await h.handlers['check-meeting-active']()).inMeeting,false);
 const a=await mainHarness('darwin','PreventUserIdleDisplaySleep 1\npid 3(Zoom): [x] 00:01:01 PreventUserIdleDisplaySleep named: "meeting"');assert.equal((await a.handlers['check-meeting-active']()).inMeeting,true);
 const p=await mainHarness('darwin','PreventUserIdleDisplaySleep 0','4321\n');assert.equal((await p.handlers['check-meeting-active']()).inMeeting,true);
 const f=await mainHarness('darwin','PreventUserIdleDisplaySleep 0','4321\n',new Error('pgrep failed'));assert.equal((await f.handlers['check-meeting-active']()).inMeeting,false);
 const unsupported=await mainHarness('linux');assert.equal((await unsupported.handlers['check-meeting-active']()).supported,false);
 assert(h.calls.some(([name,value])=>name==='loadURL'&&value==='http://127.0.0.1:5173'));
 h.handlers['set-break-fullscreen']({},true);assert.equal(h.window.fullscreen,true);h.handlers['set-break-fullscreen']({},false);h.window.emit('leave-full-screen');assert(h.calls.some(([name,value])=>name==='setBounds'&&value.x===20));
 h.handlers['set-strict-lock']({},true);h.power.emit('lock-screen');h.handlers['set-strict-lock']({},true);h.window.emit('blur');const focusCount=h.calls.filter(([name])=>name==='focus').length;h.window.emit('blur');assert.equal(h.calls.filter(([name])=>name==='focus').length,focusCount);h.power.emit('suspend');h.power.emit('resume');h.setState('locked');assert.deepEqual({...h.handlers['get-power-state']()},{suspended:false,locked:true});
 const renderer=new EventEmitter(),document={documentElement:{dataset:{}}};let bridge,domReady;vm.runInNewContext(fs.readFileSync(repo+'/electron/preload.cjs','utf8'),{require:()=>({contextBridge:{exposeInMainWorld:(_name,api)=>bridge=api},ipcRenderer:renderer}),process:{platform:'darwin'},window:{addEventListener:(_name,callback)=>domReady=callback},document});domReady();assert.equal(bridge.platform,'darwin');assert.equal(document.documentElement.dataset.platform,'darwin');
 let invoked=0;const cleanup=bridge.onPowerStateChange(()=>invoked++);assert.equal(renderer.listenerCount('power-state-change'),1);renderer.emit('power-state-change',{},'lock-screen');cleanup();assert.equal(renderer.listenerCount('power-state-change'),0);assert.equal(invoked,1);
 const removeTrigger=bridge.onTriggerBreak(()=>{});removeTrigger();assert.equal(renderer.listenerCount('trigger-break'),0);
 const duplicate=await mainHarness();duplicate.handlers['set-break-fullscreen']({},true);duplicate.power.emit('lock-screen');duplicate.handlers['set-break-fullscreen']({},false);duplicate.window.emit('leave-full-screen');assert(duplicate.calls.some(([name])=>name==='setBounds'),'duplicate release must preserve pending fullscreen restoration');
 // Simulate the OS moving windows while absent, independently of Electron's
 // visible/minimized state and the asynchronous macOS fullscreen transition.
 const externalBounds={x:2180,y:100,width:1120,height:780};
 const movedBounds={x:20,y:40,width:1120,height:780};
 for(const platform of ['darwin','win32','linux']){
  for(const events of [['lock-screen','unlock-screen'],['suspend','resume'],['lock-screen','suspend','resume','unlock-screen'],['suspend','lock-screen','unlock-screen','resume']]){
   const session=await mainHarness(platform);if(platform==='linux')await session.handlers['get-power-state']();session.window.bounds={...externalBounds};
   for(const [index,event] of events.entries()){
    session.power.emit(event);
    if(index===0)session.window.bounds={...movedBounds};
    if(index===events.length-2&&events.length===4)assert.deepEqual(session.window.bounds,movedBounds,'partial return must not restore during the other absence');
   }
   if(platform==='linux')await session.handlers['get-power-state']();
   assert.deepEqual(session.window.bounds,externalBounds,`${platform} restores monitor and bounds after ${events.join('/')}`);
   assert(!session.calls.some(([name])=>name==='focus'),`${platform} automatic restoration does not focus`);
  }
  for(const presentation of ['hidden','minimized'])for(const stateChangedWhileAbsent of [false,true]){
   const session=await mainHarness(platform);if(platform==='linux')await session.handlers['get-power-state']();session.window.bounds={...externalBounds};session.window[presentation]=true;
   session.power.emit('lock-screen');session.power.emit('suspend');session.window.bounds={...movedBounds};if(stateChangedWhileAbsent)session.window[presentation]=false;
   const start=session.calls.length;session.power.emit('resume');session.power.emit('unlock-screen');if(platform==='linux')await session.handlers['get-power-state']();
   assert.deepEqual(session.window.bounds,externalBounds);assert.equal(session.window[presentation],true);
   assert(!session.calls.slice(start).some(([name])=>['show','showInactive','focus','restore','maximize'].includes(name)),`${platform} ${presentation} window cannot be presented on return`);
   session.trayMenu.find(item=>item.label==='Показать Blincho').click();assert.equal(session.window.hidden,false);assert.equal(session.window.minimized,false,'explicit tray reopen remains available');
  }
  const visible=await mainHarness(platform);if(platform==='linux')await visible.handlers['get-power-state']();visible.power.emit('suspend');visible.window.hidden=true;const visibleStart=visible.calls.length;visible.power.emit('resume');if(platform==='linux')await visible.handlers['get-power-state']();
  assert.equal(visible.window.hidden,false,'previously visible window returns without focus');assert(visible.calls.slice(visibleStart).some(([name])=>name==='showInactive'));assert(!visible.calls.slice(visibleStart).some(([name])=>['show','focus'].includes(name)));
 }
 const disconnected=await mainHarness();disconnected.window.bounds={...externalBounds};disconnected.power.emit('suspend');disconnected.setDisplays([{id:1,workArea:{x:0,y:0,width:1280,height:800}}]);disconnected.power.emit('resume');
 assert.deepEqual(disconnected.window.bounds,{x:160,y:20,width:1120,height:780},'removed monitor falls back to a fully accessible work area');
 const rearranged=await mainHarness();rearranged.window.bounds={...externalBounds};rearranged.power.emit('lock-screen');rearranged.setDisplays([{id:1,workArea:{x:0,y:0,width:1920,height:1040}},{id:2,workArea:{x:-1920,y:0,width:1920,height:1040}}]);rearranged.power.emit('unlock-screen');
 assert.deepEqual(rearranged.window.bounds,{...externalBounds,x:-1660},'existing display identity survives a topology rearrangement');
 const maximized=await mainHarness();maximized.window.bounds={x:1920,y:0,width:1920,height:1040};maximized.window.normalBounds={...externalBounds};maximized.window.maximized=true;maximized.power.emit('suspend');maximized.window.bounds={...movedBounds};maximized.window.maximized=false;maximized.power.emit('resume');
 assert.deepEqual(maximized.window.normalBounds,externalBounds,'maximized windows preserve their normal placement');assert.equal(maximized.window.maximized,true);
 for(const leaveBeforeReturn of [false,true]){
  const asynchronous=await mainHarness('darwin','','',null,{asyncFullscreen:true});asynchronous.window.bounds={...externalBounds};asynchronous.handlers['set-break-fullscreen']({},true);asynchronous.window.bounds={x:1920,y:0,width:1920,height:1080};
  asynchronous.power.emit('lock-screen');if(leaveBeforeReturn)asynchronous.window.finishFullscreenExit();asynchronous.power.emit('suspend');asynchronous.window.bounds={...movedBounds};
  const restoreStart=asynchronous.calls.length;asynchronous.power.emit('resume');asynchronous.power.emit('unlock-screen');
  if(!leaveBeforeReturn){assert(!asynchronous.calls.slice(restoreStart).some(([name])=>name==='setBounds'),'return waits for macOS fullscreen exit');asynchronous.window.finishFullscreenExit();}
  assert.deepEqual(asynchronous.window.bounds,externalBounds,'asynchronous fullscreen cleanup cannot replace the original absence snapshot');assert.equal(asynchronous.window.fullscreen,false);
 }
 const closeDuringExit=await mainHarness('darwin','','',null,{asyncFullscreen:true});closeDuringExit.handlers['set-break-fullscreen']({},true);closeDuringExit.power.emit('lock-screen');closeDuringExit.power.emit('unlock-screen');closeDuringExit.window.close();const closeExitStart=closeDuringExit.calls.length;closeDuringExit.window.finishFullscreenExit();
 assert.equal(closeDuringExit.window.hidden,true,'explicit close while fullscreen exit is pending stays hidden');assert(!closeDuringExit.calls.slice(closeExitStart).some(([name])=>['show','showInactive','focus'].includes(name)));
 const hiddenFullscreen=await mainHarness('darwin','','',null,{asyncFullscreen:true});hiddenFullscreen.window.bounds={...externalBounds};hiddenFullscreen.window.maximized=true;hiddenFullscreen.handlers['set-break-fullscreen']({},true);hiddenFullscreen.window.hidden=true;hiddenFullscreen.power.emit('lock-screen');hiddenFullscreen.window.hidden=false;const hiddenFullscreenStart=hiddenFullscreen.calls.length;hiddenFullscreen.power.emit('unlock-screen');hiddenFullscreen.window.finishFullscreenExit();
 assert.equal(hiddenFullscreen.window.hidden,true);assert(!hiddenFullscreen.calls.slice(hiddenFullscreenStart).some(([name])=>['show','showInactive','focus','restore','maximize'].includes(name)),'fullscreen cleanup honors saved hidden state even if native visibility changed');
 const hiddenMinimized=await mainHarness('win32');hiddenMinimized.window.minimized=true;hiddenMinimized.window.close();hiddenMinimized.power.emit('suspend');hiddenMinimized.window.hidden=false;hiddenMinimized.window.minimized=false;const hiddenMinimizedStart=hiddenMinimized.calls.length;hiddenMinimized.power.emit('resume');
 assert.equal(hiddenMinimized.window.hidden,true);assert.equal(hiddenMinimized.window.minimized,true);assert(!hiddenMinimized.calls.slice(hiddenMinimizedStart).some(([name])=>['show','showInactive','focus','restore','maximize'].includes(name)),'tray-hidden minimized windows retain both background states');
 const queued=await mainHarness();queued.power.emit('lock-screen');const before=queued.calls.length;queued.handlers['bring-to-front']({},{alwaysOnTop:true});queued.handlers['set-always-on-top']({},true);assert(!queued.calls.slice(before).some(([name,value])=>['show','focus'].includes(name)||(name==='setAlwaysOnTop'&&value===true)),'queued desktop commands cannot take over a locked session');
 const nativeError=await mainHarness();nativeError.window.setAlwaysOnTop=()=>{throw Error('native setAlwaysOnTop failure')};assert.doesNotThrow(()=>nativeError.power.emit('lock-screen'));assert.equal(nativeError.warnings.length,1);assert(nativeError.calls.some(([name,channel,state])=>name==='send'&&channel==='power-state-change'&&state==='lock-screen'),'power event still reaches renderer after failed native cleanup');
 const nullPayload=await mainHarness();assert.doesNotThrow(()=>nullPayload.handlers['show-notification']({},null));assert.doesNotThrow(()=>nullPayload.handlers['bring-to-front']({},null));
 const wrongType=await mainHarness('darwin','PreventUserIdleDisplaySleep 1\npid 12(caffeinate): [x] 00:01:01 PreventUserIdleDisplaySleep named: "backup"\npid 13(Zoom): [x] 00:01:01 PreventUserIdleSystemSleep named: "PreventUserIdleDisplaySleep cleanup"');assert.equal((await wrongType.handlers['check-meeting-active']()).inMeeting,false);
 const wrongOwner=await mainHarness('darwin','PreventUserIdleDisplaySleep 1\npid 12(caffeinate): [x] 00:01:01 PreventUserIdleDisplaySleep named: "backup teams wallpaper"');assert.equal((await wrongOwner.handlers['check-meeting-active']()).inMeeting,false);
 const webRtc=await mainHarness('darwin','PreventUserIdleDisplaySleep 1\npid 12(Google Chrome): [x] 00:01:01 PreventUserIdleDisplaySleep named: "WebRTC has active PeerConnections"');assert.equal((await webRtc.handlers['check-meeting-active']()).inMeeting,true);
 const backgroundRtc='PreventUserIdleDisplaySleep 0\nPreventUserIdleSystemSleep 1\n   pid 98974(Google Chrome): [0x000ef28000019b96] 00:17:39 NoIdleSleepAssertion named: "WebRTC has active PeerConnections"';
 const backgroundCall=await mainHarness('darwin',backgroundRtc);assert.equal((await backgroundCall.handlers['check-meeting-active']()).inMeeting,true,'background Chrome call survives a zero display-sleep summary');
 for(const name of ['Playing audio','Playing video']){const playback=await mainHarness('darwin',backgroundRtc.replace('WebRTC has active PeerConnections',name));assert.equal((await playback.handlers['check-meeting-active']()).inMeeting,false);}
 for(const owner of ['Spotify','caffeinate','zoom.us']){const unrelated=await mainHarness('darwin',backgroundRtc.replace('Google Chrome',owner));assert.equal((await unrelated.handlers['check-meeting-active']()).inMeeting,false);}
 for(const kind of ['BackgroundTask','InternalPreventDisplaySleep']){const unrelated=await mainHarness('darwin',backgroundRtc.replace('NoIdleSleepAssertion',kind));assert.equal((await unrelated.handlers['check-meeting-active']()).inMeeting,false);}
 const systemRtc=await mainHarness('darwin',backgroundRtc.replace('NoIdleSleepAssertion','PreventUserIdleSystemSleep'));assert.equal((await systemRtc.handlers['check-meeting-active']()).inMeeting,true);
 const unknown=await mainHarness();unknown.setState('unknown');assert.throws(()=>unknown.handlers['get-power-state']());
 const latched=await mainHarness();latched.power.emit('lock-screen');latched.setState('active');assert.equal(latched.handlers['get-power-state']().locked,true,'native active samples cannot clear an observed lock before unlock');const latchedStart=latched.calls.length;latched.handlers['bring-to-front']({},{alwaysOnTop:true});assert(!latched.calls.slice(latchedStart).some(([name])=>name==='focus'));latched.power.emit('unlock-screen');assert.equal(latched.handlers['get-power-state']().locked,false);
 const packaged=await mainHarness('darwin','','',null,{packaged:true,env:{NODE_ENV:'development',VITE_DEV_SERVER:'true',VITE_DEV_SERVER_URL:'http://127.0.0.1:5173'}});assert(packaged.calls.some(([name,value])=>name==='loadFile'&&portablePath(value).endsWith('/dist/index.html')));assert(!packaged.calls.some(([name])=>name==='loadURL'),'packaged app must ignore inherited dev server environment');
 const background=await mainHarness();assert.equal(background.window.options.webPreferences.backgroundThrottling,false,'hidden desktop clock must keep sampling presence');assert.equal(background.window.options.webPreferences.sandbox,true);assert.equal(background.window.options.webPreferences.contextIsolation,true);
 const closeToTray=await mainHarness();const originalWindow=closeToTray.window;assert.equal(originalWindow.close(),true);assert.equal(originalWindow.destroyed,false,'ordinary close must preserve renderer timer');assert.equal(originalWindow.hidden,true);closeToTray.trayMenu.find(item=>item.label==='Показать Blincho').click();assert.equal(closeToTray.window,originalWindow);assert.equal(originalWindow.hidden,false);originalWindow.minimized=true;closeToTray.listeners['second-instance']();assert.equal(originalWindow.minimized,false);
 const strictClose=await mainHarness();strictClose.handlers['set-strict-lock']({},true);strictClose.window.close();assert.equal(strictClose.window.hidden,false,'strict break cannot hide on close');assert(strictClose.calls.some(([name])=>name==='flashFrame'));let preventedMinimize=false;strictClose.window.emit('minimize',{preventDefault(){preventedMinimize=true}});assert.equal(preventedMinimize,true);strictClose.handlers['minimize-to-tray']();assert.equal(strictClose.window.hidden,false);
 for(const reopen of ['activate','second-instance','tray']){const destroyed=await mainHarness();destroyed.window.destroy();if(reopen==='tray')destroyed.trayMenu.find(item=>item.label==='Показать Blincho').click();else destroyed.listeners[reopen]();assert.equal(destroyed.windows.length,2,`${reopen} restores a lost renderer`);assert.equal(destroyed.window.destroyed,false);assert(destroyed.calls.some(([name])=>name==='loadURL'));}
 const trayBreak=await mainHarness();trayBreak.window.destroy();trayBreak.trayMenu.find(item=>item.label==='Сделать перерыв сейчас').click();assert.equal(trayBreak.windows.length,2);assert(!trayBreak.calls.some(([name,channel])=>name==='send'&&channel==='trigger-break'),'new renderer must load before tray trigger');trayBreak.window.finishLoad();assert.equal(trayBreak.calls.filter(([name,channel])=>name==='send'&&channel==='trigger-break').length,1);trayBreak.trayMenu.find(item=>item.label==='Сделать перерыв сейчас').click();assert.equal(trayBreak.calls.filter(([name,channel])=>name==='send'&&channel==='trigger-break').length,2);
 for(const absent of ['lock-screen','suspend']){const noTakeover=await mainHarness();noTakeover.window.destroy();noTakeover.power.emit(absent);const beforeActions=noTakeover.calls.length;noTakeover.listeners.activate();noTakeover.listeners['second-instance']();noTakeover.trayMenu.find(item=>item.label==='Показать Blincho').click();noTakeover.trayMenu.find(item=>item.label==='Сделать перерыв сейчас').click();assert.equal(noTakeover.windows.length,1);assert(!noTakeover.calls.slice(beforeActions).some(([name])=>['show','focus','send'].includes(name)),`${absent} blocks foreground recovery and tray takeover`);}
 const quitStrict=await mainHarness();quitStrict.handlers['set-strict-lock']({},true);quitStrict.app.quit();assert.equal(quitStrict.window.destroyed,true,'explicit app quit must not be intercepted by close-to-tray or strict break');quitStrict.listeners.activate();quitStrict.listeners['second-instance']();assert.equal(quitStrict.windows.length,1,'quitting cannot recreate renderer');
 const trayQuit=await mainHarness();trayQuit.window.close();trayQuit.trayMenu.find(item=>item.label==='Выход').click();assert.equal(trayQuit.window.destroyed,true);assert.equal(trayQuit.calls.filter(([name])=>name==='quit').length,1);
 const queuedTray=await mainHarness();queuedTray.trayMenu.find(item=>item.label==='Сделать перерыв сейчас').click();queuedTray.power.emit('lock-screen');queuedTray.window.finishLoad();assert(!queuedTray.calls.some(([name,channel])=>name==='send'&&channel==='trigger-break'),'queued tray trigger cannot run after locking');
 const diagnostics=await mainHarness();diagnostics.handlers['set-strict-lock']({},true);diagnostics.handlers['set-break-fullscreen']({},true);diagnostics.handlers['bring-to-front']({},{alwaysOnTop:true});diagnostics.power.emit('lock-screen');let current=diagnostics.diagnostics.current;assert.equal(current.locked,true);assert.equal(current.strictLockActive,false);assert.equal(current.alwaysOnTop,false);assert.equal(current.fullscreen,false);diagnostics.power.emit('unlock-screen');diagnostics.power.emit('suspend');diagnostics.power.emit('resume');assert.deepEqual(diagnostics.diagnostics.events.filter(event=>['lock-screen','unlock-screen','suspend','resume'].includes(event.event)).map(event=>event.event),['lock-screen','unlock-screen','suspend','resume']);assert.equal(diagnostics.diagnostics.current.suspended,false);assert.equal(diagnostics.diagnostics.current.locked,false);assert(diagnostics.diagnosticWrites.every(write=>write.options.mode===0o600),'diagnostics files are private');assert(diagnostics.diagnosticWrites.every(write=>portablePath(write.file).endsWith('/runtime-diagnostics.json.tmp')),'snapshots write through a temporary file');
 const bounded=await mainHarness();for(let i=0;i<80;i++)bounded.handlers['set-strict-lock']({},Boolean(i%2));assert.equal(bounded.diagnostics.events.length,60);const beforeIdle=bounded.diagnosticWrites.length;for(let i=0;i<100;i++){bounded.handlers['get-system-idle-time']();bounded.handlers['get-power-state']()}assert.equal(bounded.diagnosticWrites.length,beforeIdle,'routine polling does not write diagnostics');const allowed=['event','recordedAt','suspended','locked','strictLockActive','quitting','windowExists','windowVisible','fullscreen','alwaysOnTop'];assert(bounded.diagnostics.events.every(event=>Object.keys(event).every(key=>allowed.includes(key))),'records contain only lifecycle/power/window fields');
 const unavailableDiagnostics=await mainHarness('darwin','','',null,{diagnosticsError:new Error('read-only data directory')});assert.doesNotThrow(()=>{unavailableDiagnostics.handlers['set-strict-lock']({},true);unavailableDiagnostics.power.emit('lock-screen');unavailableDiagnostics.window.close()});assert.equal(unavailableDiagnostics.warnings.length,1,'diagnostics failure warns once and never blocks lifecycle');assert.equal(unavailableDiagnostics.window.hidden,true);assert.equal(unavailableDiagnostics.handlers['get-power-state']().locked,true);
 for(const platform of ['darwin','win32','linux']){
  const os=await mainHarness(platform);if(platform==='linux')await os.handlers['get-power-state']();assert.equal(os.window.options.titleBarStyle,platform==='darwin'?'hiddenInset':'default');assert(portablePath(os.window.options.icon).endsWith('/public/symbiote/00.png'));
  assert.equal(os.window.options.webPreferences.backgroundThrottling,false);assert.equal(os.window.options.webPreferences.sandbox,true);assert.equal(portablePath(os.app.getPath('userData')),'/virtual/myeyes');
  if(platform==='darwin')assert(os.calls.some(([name,flag])=>name==='setTemplateImage'&&!flag));
  if(platform==='win32'){assert(os.calls.some(([name,value])=>name==='setAppUserModelId'&&value==='com.myeyes.app'));assert(portablePath(os.tray.icon.path).endsWith('/public/symbiote/00.png'));}
  if(platform==='linux')assert(os.calls.some(([name,value])=>name==='setDesktopName'&&value==='com.myeyes.app.desktop'));
  os.window.close();assert.equal(os.window.destroyed,false);assert.equal(os.window.minimized,platform==='linux');assert.equal(os.window.hidden,platform!=='linux');
  if(platform!=='darwin'){os.tray.emit('click');assert.equal(os.window.hidden,false);assert.equal(os.window.minimized,false);assert.equal((await os.handlers['check-meeting-active']()).supported,false);assert.equal(os.execCalls.filter(call=>call.file!=='loginctl').length,0);}
  os.handlers['set-break-fullscreen']({},true);os.handlers['set-break-fullscreen']({},false);if(platform==='darwin')os.window.emit('leave-full-screen');assert(os.calls.some(([name])=>name==='setBounds'));
  os.handlers['set-strict-lock']({},true);os.window.close();assert.equal(os.window.hidden,false);os.power.emit('lock-screen');const beforeActions=os.calls.length;os.handlers['bring-to-front']({},{alwaysOnTop:true});os.handlers['show-notification']({},{title:'Blincho'});os.notifications.at(-1).emit('click');os.tray.emit('click');assert(!os.calls.slice(beforeActions).some(([name])=>['show','focus'].includes(name)),`${platform} notifications and tray respect lock`);
  if(platform==='linux')assert(portablePath(os.notifications.at(-1).options.icon).endsWith('/public/symbiote/00.png'));
 }
 for(const platform of ['win32','linux']){const noTray=await mainHarness(platform,'','',null,{trayError:new Error('tray unsupported')});noTray.window.close();assert.equal(noTray.window.hidden,false);assert.equal(noTray.window.minimized,true);assert.equal(noTray.window.destroyed,false);assert.equal(noTray.warnings.length,1);}
 for (const platform of ['darwin', 'win32', 'linux']) {
  const build = await mainHarness(platform);
  const event = {sender:build.window.webContents, senderFrame:build.window.webContents.mainFrame};
  assert.throws(()=>build.handlers['set-symbiote-build']({},63), /main renderer/);
  assert.throws(()=>build.handlers['set-symbiote-build']({...event,senderFrame:{}},63), /main renderer/);
  for (const invalid of [-1,64,1.5,'63',null,{},NaN]) assert.throws(()=>build.handlers['set-symbiote-build'](event,invalid), /Invalid build mask/);
  build.window.hidden=true;
  const start=build.calls.length;
  for (let mask=0;mask<64;mask++) {
   build.handlers['set-symbiote-build'](event,mask);
   const expected=`/public/symbiote/${mask.toString(16).padStart(2,'0')}.png`;
   assert(portablePath(build.tray.icon.path).endsWith(expected));
   assert(portablePath(build.calls.findLast(([name])=>name===(platform==='darwin'?'dockIcon':'setIcon'))[1]).endsWith(expected));
  }
  assert.equal(build.window.hidden,true);
  assert(!build.calls.slice(start).some(([name])=>['show','focus','restore'].includes(name)));
  build.handlers['show-notification']({},{});
  assert(portablePath(build.notifications.at(-1).options.icon).endsWith('/public/symbiote/3f.png'));
  const generation=build.handlers['camera-activity-generation'](event);
  const cameraInput={generation,revision:1,active:true,label:'Blincho is using the camera'};
  assert.throws(()=>build.handlers['camera-activity-update']({},cameraInput),/main renderer/);
  assert.throws(()=>build.handlers['camera-activity-update']({...event,senderFrame:{}},cameraInput),/main renderer/);
  build.handlers['camera-activity-update'](event,cameraInput);
  assert.equal(build.tray.icon.path,'camera-active');
  assert.equal(build.tray.tooltip,'Blincho\nBlincho is using the camera');
  build.handlers['set-symbiote-build'](event,5); assert.equal(build.tray.icon.path,'camera-active');
  assert.throws(()=>build.handlers['camera-activity-update'](event,cameraInput),/obsolete/);
  build.window.webContents.emit('did-start-navigation',{},'tauri://localhost',false,false);
  assert.equal(build.tray.icon.path,'camera-active','subframe navigation does not release the main camera');
  build.window.close(); assert.equal(build.tray.icon.path,'camera-active','close-to-tray preserves live capture');
  build.handlers['camera-activity-update'](event,{...cameraInput,revision:2,active:false});
  assert(portablePath(build.tray.icon.path).endsWith('/public/symbiote/05.png'));
  build.handlers['camera-activity-update'](event,{...cameraInput,revision:3});
  build.window.webContents.emit('did-start-navigation',{},'tauri://localhost',false,true);
  assert(portablePath(build.tray.icon.path).endsWith('/public/symbiote/05.png'));
  assert.throws(()=>build.handlers['camera-activity-update'](event,{...cameraInput,revision:4}),/obsolete/);
  const nextGeneration=build.handlers['camera-activity-generation'](event);
  build.handlers['camera-activity-update'](event,{...cameraInput,generation:nextGeneration});
  build.window.webContents.emit('render-process-gone',{},{});
  assert(portablePath(build.tray.icon.path).endsWith('/public/symbiote/05.png'));
  build.handlers['set-symbiote-build'](event,63);
  build.window.destroy();build.listeners.activate();
  assert(portablePath(build.window.options.icon).endsWith('/public/symbiote/3f.png'));
  const packaged=await mainHarness(platform,'','',null,{packaged:true});
  assert(portablePath(packaged.window.options.icon).endsWith('/dist/symbiote/00.png'));
 }
 const secondProcess=await mainHarness('win32','','',null,{instanceLock:false});assert.equal(secondProcess.windows.length,0,'failed single-instance lock cannot create another renderer');
 const meetingAssertion='PreventUserIdleDisplaySleep 1\npid 3(Zoom): [x] 00:01:01 PreventUserIdleDisplaySleep named: "meeting"';
 const cached=await mainHarness('darwin',meetingAssertion);await Promise.all(Array.from({length:100},()=>cached.handlers['check-meeting-active']()));assert.equal(cached.execCalls.length,1,'100 concurrent requests share one assertion probe and skip pgrep');
 for(let i=0;i<100;i++)assert.equal((await cached.handlers['check-meeting-active']()).inMeeting,true);assert.equal(cached.execCalls.length,1,'cache suppresses repeated probes for ten seconds');
 cached.advanceTime(9999);await cached.handlers['check-meeting-active']();assert.equal(cached.execCalls.length,1);cached.advanceTime(1);await cached.handlers['check-meeting-active']();assert.equal(cached.execCalls.length,2,'expired result must be refreshed');
 cached.power.emit('lock-screen');await cached.handlers['check-meeting-active']();assert.equal(cached.execCalls.length,2,'locked session runs no native meeting probe');cached.power.emit('unlock-screen');await cached.handlers['check-meeting-active']();assert.equal(cached.execCalls.length,3,'unlock invalidates pre-lock result');
 const noMeeting=await mainHarness();await Promise.all(Array.from({length:100},()=>noMeeting.handlers['check-meeting-active']()));assert.equal(noMeeting.execCalls.length,2,'100 negative requests share one bounded pair of subprocesses');for(const call of noMeeting.execCalls){assert(call.file.startsWith('/usr/bin/'));assert(Array.isArray(call.args));assert.equal(call.options.timeout,1000);assert.equal(call.options.maxBuffer,256*1024);assert.equal(call.options.shell,undefined);}
 const racing=await mainHarness('darwin','','',null,{deferProbes:true});const inFlight=racing.handlers['check-meeting-active']();assert.equal(racing.execCalls.length,1);racing.power.emit('suspend');racing.pendingProbes.shift()();assert.equal((await inFlight).inMeeting,false);assert.equal(racing.execCalls.length,1,'suspend cancels the second pending probe');
 // Linux has no powerMonitor lock/unlock events. Exercise sampled transitions
 // through the real session adapter, with only loginctl/Electron mocked.
 const linux=await mainHarness('linux');
 linux.handlers['set-strict-lock']({},true);linux.handlers['set-break-fullscreen']({},true);linux.handlers['bring-to-front']({},{alwaysOnTop:true});
 assert.equal(linux.window.fullscreen,undefined,'automatic takeover waits for initial Linux session confirmation');
 assert.equal(linux.diagnostics.current.strictLockActive,false);
 assert.deepEqual({...await linux.handlers['get-power-state']()},{suspended:false,locked:false});
 linux.handlers['set-strict-lock']({},true);linux.handlers['set-break-fullscreen']({},true);linux.handlers['bring-to-front']({},{alwaysOnTop:true});
 assert.equal(linux.window.fullscreen,true);assert.equal(linux.window.alwaysOnTop,true);
 linux.setLinuxSession('Active=yes\nLockedHint=yes');linux.advanceTime(250);
 assert.equal((await linux.handlers['get-power-state']()).locked,true);
 assert.equal(linux.window.fullscreen,false);assert.equal(linux.window.alwaysOnTop,false);assert.equal(linux.diagnostics.current.strictLockActive,false);
 assert(linux.calls.some(([name,channel,state])=>name==='send'&&channel==='power-state-change'&&state==='lock-screen'));
 linux.setLinuxSession('Active=yes\nLockedHint=no');linux.advanceTime(250);
 assert.equal((await linux.handlers['get-power-state']()).locked,false,'fresh sample recovers without a nonexistent native unlock event');
 assert(linux.calls.some(([name,channel,state])=>name==='send'&&channel==='power-state-change'&&state==='unlock-screen'));
 linux.handlers['set-break-fullscreen']({},true);assert.equal(linux.window.fullscreen,true);
 linux.setState('locked');linux.advanceTime(250);assert.equal((await linux.handlers['get-power-state']()).locked,true,'Chromium screen-saver lock supplements a lagging logind hint');
 linux.setState('active');linux.advanceTime(250);assert.equal((await linux.handlers['get-power-state']()).locked,false);
 linux.setLinuxSession('Active=no\nLockedHint=no');linux.advanceTime(250);assert.equal((await linux.handlers['get-power-state']()).locked,true,'switched-away session is absent');
 linux.setLinuxSession('Active=yes\nLockedHint=no');linux.advanceTime(250);await linux.handlers['get-power-state']();
 linux.handlers['set-strict-lock']({},true);linux.handlers['set-break-fullscreen']({},true);linux.handlers['bring-to-front']({},{alwaysOnTop:true});
 linux.setLinuxSession('',new Error('loginctl unavailable'));linux.advanceTime(250);await assert.rejects(linux.handlers['get-power-state'](),/unavailable/);
 assert.equal(linux.window.fullscreen,false);assert.equal(linux.window.alwaysOnTop,false);assert.equal(linux.diagnostics.current.strictLockActive,false);assert.equal(linux.diagnostics.events.at(-1).event,'linux-session-unconfirmed','failure records released presentation without fabricating a lock event');
 linux.handlers['set-strict-lock']({},true);assert.equal(linux.diagnostics.current.strictLockActive,false,'unknown session cannot reacquire strict lock');
 linux.setLinuxSession('Active=yes\nLockedHint=no');linux.advanceTime(250);await linux.handlers['get-power-state']();
 linux.handlers['set-break-fullscreen']({},true);assert.equal(linux.window.fullscreen,true,'a fresh successful query recovers presentation');
 linux.power.emit('suspend');linux.power.emit('resume');linux.handlers['set-break-fullscreen']({},true);assert.equal(linux.window.fullscreen,false,'wake requires a new session query');
 linux.advanceTime(250);await linux.handlers['get-power-state']();linux.handlers['set-break-fullscreen']({},true);assert.equal(linux.window.fullscreen,true);
 const linuxRace=await mainHarness('linux','','',null,{deferProbes:true});
 const oldLinuxRead=assert.rejects(linuxRace.handlers['get-power-state'](),/stale/);
 linuxRace.power.emit('suspend');linuxRace.power.emit('resume');linuxRace.advanceTime(250);
 const freshLinuxRead=linuxRace.handlers['get-power-state']();assert.equal(linuxRace.pendingProbes.length,2);
 linuxRace.pendingProbes[1]();await freshLinuxRead;linuxRace.pendingProbes[0]();await oldLinuxRead;
 linuxRace.handlers['set-break-fullscreen']({},true);assert.equal(linuxRace.window.fullscreen,true,'old rejection cannot invalidate a newer confirmed session');
 for(const platform of ['darwin','win32']){
  const sampled=await mainHarness(platform);sampled.handlers['set-strict-lock']({},true);sampled.handlers['set-break-fullscreen']({},true);sampled.handlers['bring-to-front']({},{alwaysOnTop:true});sampled.setState('locked');
  assert.equal(sampled.handlers['get-power-state']().locked,true);assert.equal(sampled.window.fullscreen,false);assert.equal(sampled.window.alwaysOnTop,false);assert.equal(sampled.diagnostics.current.strictLockActive,false,'sampled native lock releases presentation even when its event was missed');
  sampled.power.emit('suspend');sampled.power.emit('resume');sampled.setState('active');assert.equal(sampled.handlers['get-power-state']().locked,true,'wake cannot erase a Windows/macOS lock before unlock');sampled.power.emit('unlock-screen');assert.equal(sampled.handlers['get-power-state']().locked,false);
 }
 const config=JSON.parse(fs.readFileSync(repo+'/package.json','utf8'));assert.equal(config.build.appId,'com.myeyes.app');assert.equal(config.build.mac.icon,'assets/icon.icns');assert.equal(config.build.win.icon,'assets/icon.ico');assert.equal(config.build.linux.icon,'assets/512x512.png');assert.deepEqual(config.build.win.target,['nsis','portable']);assert.deepEqual(config.build.linux.target,['AppImage','tar.gz']);assert.equal(config.desktopName,'com.myeyes.app.desktop');assert.equal(config.build.linux.syncDesktopName,true);
 console.log('Passed Electron VM: previous lifecycle/absence/profile regressions plus macOS/Windows/Linux session placement, hidden/minimized restoration, overlapping lock/suspend, disconnected/rearranged displays, delayed macOS fullscreen exit, window, icon, tray, taskbar fallback, notification lock guard, single-instance and preload behavior. Probe counts: 100 concurrent positive requests = 1 execFile; negative = 2; cached repeat = 0; unsupported platforms = 0. Cache expiry, power invalidation and subprocess bounds passed. Native OS session behavior is not certified by this VM test.');
})().catch(error=>{console.error(error);process.exitCode=1});
