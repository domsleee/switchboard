import asyncio
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from attention_scan import classify,scan_sessions

class DetectionTests(unittest.TestCase):
 def test_live_states_and_old_transcript(self):
  codex={'pane_command':'cmd.exe /c codex.cmd resume','title':'ssb orchestrator'}
  idle='• Result ready\nWorked for 3m 51s • 8:06 PM\n› Ask Codex to do anything\nGPT-6.1-Sol high · Main\n? for shortcuts'
  self.assertEqual(classify(codex,idle)['state'],'ready')
  self.assertEqual(classify(codex,'• Working (3m 26s • esc to interrupt)\n› draft\nGPT-6.1-Sol high · tab to queue message')['state'],'working')
  self.assertEqual(classify(codex,'Would you like to run this command?\n› 1. Yes, proceed\n  2. No\nPress enter to confirm or esc to cancel')['state'],'approval')
  old='Would you like to run this command?\n› 1. Yes, proceed\n2. No\nPress enter to confirm or esc to cancel\n'
  self.assertEqual(classify(codex,old+idle)['state'],'ready')
  duration='• Result ready\nWorked for 1m 34s\n› Ask Codex to do anything\n? for shortcuts'
  self.assertEqual(classify(codex,duration)['token'],classify(codex,'older reflowed content\n'+duration)['token'])
  claude={'pane_command':'claude.exe --resume','title':'✳ work'}
  self.assertEqual(classify(claude,'● Result\n✻ Baked for 4m 5s\n❯ \n⏵⏵ bypass permissions on (shift+tab to cycle)')['state'],'ready')
  self.assertEqual(classify({'pane_command':'nu','title':'~'},idle)['state'],'ready') # recognizable agent footer
  self.assertEqual(classify({'pane_command':'nu','title':'~'},'quiet shell prompt')['state'],'unknown')
 def test_disappeared_pane_does_not_discard_others(self):
  panes=[{'id':1,'is_plugin':False,'tab_id':42,'tab_position':0,'tab_name':'First','title':'codex - task'},
         {'id':2,'is_plugin':False,'tab_id':90,'tab_position':1,'tab_name':'Second','title':'codex - other'}]
  def run(binary,session,*args,**kwargs):
   if args[0]=='list-panes':
    return json.dumps(panes)
   if args[-1]=='1':raise RuntimeError('gone')
   return 'Worked for 2s\n› Ask Codex to do anything\n? for shortcuts'
  with patch('attention_scan.run',run):snapshot=scan_sessions(['main'])
  self.assertEqual([r['state'] for r in snapshot['panes']],['unknown','ready'])
  self.assertEqual([tab['id'] for tab in snapshot['tabs']],[42,90])

 def test_catalog_keeps_tab_identity_after_first_pane_moves_or_closes(self):
  first={'id':7,'is_plugin':False,'tab_id':42,'tab_position':1,'tab_name':'Original','title':'codex - task'}
  second={**first,'id':8,'title':'codex - other'}
  plugin={**first,'id':7,'is_plugin':True,'tab_id':90,'tab_position':0,'tab_name':'Plugin tab'}
  hidden={**first,'id':9,'is_suppressed':True}
  bar={**first,'id':10,'is_plugin':True,'is_selectable':False}
  def snapshot(panes,offset=0):
   def run(binary,session,*args,**kwargs):
    return json.dumps(panes) if args[0]=='list-panes' else ''
   with patch('attention_scan.run',run):return scan_sessions(['main'],offset=offset)
  original=snapshot([first,second,plugin,hidden,bar],offset=3)
  self.assertEqual([tab['id'] for tab in original['tabs']],[90,42])
  self.assertEqual([p['pane_id'] for p in original['tabs'][1]['panes']],[7,8])
  moved=snapshot([{**first,'tab_id':90,'tab_position':0,'tab_name':'Plugin tab'},second,plugin])
  closed=snapshot([second,plugin])
  for current in (moved,closed):
   tab=next(tab for tab in current['tabs'] if tab['id']==42)
   self.assertEqual((tab['session'],tab['position'],tab['name']),('main',1,'Original'))
   self.assertEqual([p['pane_id'] for p in tab['panes']],[8])
  self.assertEqual(original['tabs'][0]['panes'][0]['is_plugin'],True)


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
 async def test_publishes_native_tabs_and_clears_them_when_host_disconnects(self):
  from attention import lifecycle
  app={'hosts':{'mac':SimpleNamespace(config={'id':'mac'})}}
  snapshot={'panes':[{'session':'main','pane_id':7,'tab_id':42,'state':'ready','token':'result'}],
            'tabs':[{'session':'main','id':42,'position':0,'name':'Original','panes':[]}]}
  sleeps=asyncio.Queue()
  async def pause(_):
   resume=asyncio.get_running_loop().create_future()
   await sleeps.put(resume)
   await resume
  async def scan(_):
   if app.get('fail'):raise RuntimeError('Disconnected')
   return snapshot
  with patch('attention.scan_host',scan),patch('attention.asyncio.sleep',pause):
   context=lifecycle(app)
   await anext(context)
   try:
    resume=await asyncio.wait_for(sleeps.get(),1)
    self.assertEqual(app['attention']['tabs'],[{**snapshot['tabs'][0],'host':'mac'}])
    self.assertEqual(app['attention']['panes'][0]['token'],'result:0')
    app['fail']=True
    resume.set_result(None)
    await asyncio.wait_for(sleeps.get(),1)
    self.assertEqual(app['attention']['tabs'],[])
    self.assertEqual(app['attention']['panes'],[])
    self.assertEqual(app['attention']['errors'][0]['host'],'mac')
   finally:
    with self.assertRaises(StopAsyncIteration):await anext(context)
if __name__=='__main__':unittest.main()
