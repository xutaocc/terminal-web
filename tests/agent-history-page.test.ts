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
