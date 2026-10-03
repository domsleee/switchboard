import unittest
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
  panes=[{'id':1,'is_plugin':False,'tab_id':0,'title':'codex - task'},{'id':2,'is_plugin':False,'tab_id':1,'title':'codex - other'}]
  def run(binary,session,*args,**kwargs):
   if args[0]=='list-panes':
    import json;return json.dumps(panes)
   if args[-1]=='1':raise RuntimeError('gone')
   return 'Worked for 2s\n› Ask Codex to do anything\n? for shortcuts'
  with patch('attention_scan.run',run):rows=scan_sessions(['main'])
  self.assertEqual([r['state'] for r in rows],['unknown','ready'])
if __name__=='__main__':unittest.main()
