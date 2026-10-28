import test from 'node:test';
import assert from 'node:assert/strict';
import { renderAgentHistory } from '../src/agent-history-page.js';
test('history renders code as text and collapses raw commands', () => {
  const html = renderAgentHistory({label:'<script>attack</script>', records:[{input:'encoded-original',decodedInput:'write BASE64_EXPR',decodedParts:[{expression:'BASE64_EXPR',status:'decoded',text:'<img src=x onerror=attack()>print("hello")'}]}]});
  assert(!html.includes('<script>'));
  assert(!html.includes('<img src=x'));
  assert(html.includes('&lt;img'));
  assert(html.includes('print(&quot;hello&quot;)'));
  assert(html.indexOf('encoded-original') > html.indexOf('<details>'));
  assert(html.includes('内容片段 1，见下方'));
  assert(renderAgentHistory(null).includes('会话不存在'));
});

test('navigation exists at both ends and return links stay on the controller origin', async () => {
  const {historyTerminalHref}=await import('../src/agent-history-page.js');
  const name='agent_'+'a'.repeat(32);
  const remote='@b1c4ab8d/'+name;
  assert.equal(historyTerminalHref(name,remote),'/?focus='+encodeURIComponent(remote));
  assert.equal(historyTerminalHref(name),'/?focus='+name);
  assert.equal(historyTerminalHref('bad','https://evil.invalid'),'/');
  assert.equal(historyTerminalHref(name,'@bad/agent_'+'b'.repeat(32)),'/?focus='+name);
  const html=renderAgentHistory({label:'test',records:[]},historyTerminalHref(name,remote));
  assert.equal((html.match(/← 返回终端/g)||[]).length,2);
  assert.equal((html.match(/href="#history-top"/g)||[]).length,2);
  assert.equal((html.match(/href="#history-bottom"/g)||[]).length,2);
  assert(html.includes('id="history-top"')); assert(html.includes('id="history-bottom"'));
  assert(!renderAgentHistory(null,'javascript:alert(1)').includes('javascript:'));
});
