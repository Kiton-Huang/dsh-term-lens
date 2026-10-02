/**
 * 页面环境探测行（精简版）。
 *
 * 三轮探测已经把「bundle 在哪、能不能取到」问清楚了：
 *
 *   页面来源     dsh-app://app/（自定义协议，supportFetchAPI / corsEnabled 都开）
 *   我的 entry   url = `plugins/??dsh-term-lens/client.js&rev=<rev>`，immediately=true
 *   取这个地址   fetch → 200，65135 字节  ✅ bundle 就在服务器上
 *   加载器       pendingQueue 里卡的是内置包，不是我 → 我的 bundle 没被执行
 *   页面全局     没有 React / ReactDOM
 *
 * 结论：不再等加载器。由宿主注入的行把 bundle 取回来交给真加载器
 * （见 client-sync.js 的 buildLoaderRecoveryScript）。
 *
 * 所以这一轮探测只保留「判断自愈有没有成功」必需的几项，尽量轻。
 * 投递过程本身的成败由 client-sync 的 client-ping 回执负责报告。
 */

export function buildEnvProbeRow(opts = {}) {
  const endpoint = opts.endpoint ?? '/term-lens/env'
  const text = `;(function(){try{
function enc(s){ try{ return encodeURIComponent(String(s)) }catch(e){ return 'x' } }
var parts=[];
function add(k,v){ parts.push(k+'='+enc(v)) }

// 加载器待处理队列：我进去了没有、卡的是谁
try{
  var q=(window.__ModuleLoader__||{}).pendingQueue;
  var ids=[];
  if(Array.isArray(q)){ for(var i=0;i<q.length;i++){ ids.push(String((q[i]&&q[i].id)||'?')) } }
  add('pendingIds', ids.join('|'));
  add('pendingCount', ids.length);
  add('mineQueued', ids.indexOf('dsh-term-lens')>=0 ? '1':'0');
}catch(e){ add('pendingErr', e&&e.message) }

// 客户端有没有跑起来
try{ add('applied', window.__dshTermLensApplied?'1':'0') }catch(e){}

// 页面上有没有我们的 DOM —— 最直接的成功证据
try{
  var d=window.document||document;
  add('hasChip', d.getElementById&&d.getElementById('dsh-term-lens-chip')?'1':'0');
  add('hasStyle', d.querySelector&&d.querySelector('style[data-plugin-css="dsh-term-lens/styles.css"]')?'1':'0');
}catch(e){ add('domErr', e&&e.message) }

try{ add('streamBaseUrl', String((window.__DSH_TRANSPORT__||{}).streamBaseUrl||'')) }catch(e){}

var x=new XMLHttpRequest();
x.open('GET','${endpoint}?'+parts.join('&')+'&t='+Date.now(),true);
x.send(null);
}catch(e){}})();`
  return { kind: 'script', placement: 'body', text }
}
