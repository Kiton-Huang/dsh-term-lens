/**
 * dsh-term-lens —— 客户端加载状态观测（只读）
 *
 * ══ 两轮实测把结论反过来了 ═══════════════════════════════════════════
 *
 * 第一轮：`pendingQueue` 里有 `{id:"@deepseek-ai/dsh-client-modules", factory:…}`
 *         —— 队列项**带 factory**，说明「在队列里」等价于「已注册」。
 *         我以为队列空 = 没加载，于是做了「自愈投递」。
 *
 * 第二轮：自愈的实测回执是
 *             phase=handoff-threw
 *             detail=client-modules: duplicate factory registration for
 *                    "dsh-term-lens" (bundle executed twice without invalidate?)
 *         **「duplicate factory registration」证明 DSH 的加载器早就成功加载并
 *         注册了我们的 bundle。** 我们再喂一次就撞了重复注册，反而把加载器弄出错。
 *
 * 所以真正的问题从来不是「bundle 送不到」，而是
 * **「加载器注册了 factory，却没有执行 apply(ctx)」**。
 * 这需要观测，不是投递 —— 自愈那段已经删掉。
 *
 * ══ 这个脚本只做只读观测 ══════════════════════════════════════════════
 *
 *   - 加载器队列里有什么
 *   - 我们的 factory 是否已注册（用一次探针 load 看是否报 duplicate）
 *   - 客户端 DOM 有没有出现（apply 真的跑了的铁证）
 *
 * 全程推迟到 boot 之后；只有异步 XHR；不动任何全局。
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { buildEnvProbeRow } from './env-probe.js'

const here = dirname(fileURLToPath(import.meta.url))

/** client.js 源码。读不到返回 null，整套机制跳过。 */
export function readClientSource() {
  try {
    return readFileSync(join(here, 'client.js'), 'utf8')
  } catch {
    return null
  }
}

/** 内容哈希前 12 位，作为版本标记。 */
export function clientBundleStamp(source) {
  const text = source ?? readClientSource()
  if (!text) return null
  return createHash('sha1').update(text).digest('hex').slice(0, 12)
}

/**
 * boot 完成后再执行的门闸。
 *
 * 这是本文件最重要的一段。它保证注入脚本在启动阶段**什么都不做** ——
 * 只是把自己排进队列。曾经因为「在解析期干活 + 同步 XHR + 自动重载」
 * 把 DSH 启动搞崩过，这三条铁律就是这么来的。
 */
export const DEFER_PREAMBLE = `
function __tlReady(fn){
  function schedule(){
    try{ requestAnimationFrame(function(){ setTimeout(fn, 0) }) }
    catch(e){ setTimeout(fn, 0) }
  }
  try{
    if(document.readyState==='complete'||document.readyState==='interactive'){ schedule(); return }
    window.addEventListener('DOMContentLoaded', schedule, {once:true});
  }catch(e){ schedule() }
}
`

/**
 * 只读观测脚本：报告加载器状态与 DOM 证据。
 *
 * ⚠️ 这里**不做任何写入**。
 *
 * 曾经用一个「探针 `ml.load({id: WANT_ID, …})`」来判断 factory 是否已注册 ——
 * 那本身就会往加载器里注册一个同 id 的空工厂，**污染真实状态**（很可能
 * 把真 bundle 的注册顶掉）。观测绝不能有副作用。
 *
 * 所以只读三样：
 *   - 加载器队列快照（有没有我们、队列长度）
 *   - 启动清单里我们那条 entry 的 url / rev
 *   - DOM 里我们的节点在不在（apply 真的跑了的铁证）
 */
export function buildLoaderObservationScript(stamp, targetId = 'dsh-term-lens', pingPath = '/term-lens/client-ping') {
  return `${DEFER_PREAMBLE}
__tlReady(function(){
var WANT_ID=${JSON.stringify(targetId)};
var WANT_REV=${JSON.stringify(stamp)};
var PING=${JSON.stringify(pingPath)};

function report(phase,detail){
  try{
    var u=PING+'?phase='+encodeURIComponent(phase)+'&detail='+encodeURIComponent(String(detail||'').slice(0,300))+'&rev='+encodeURIComponent(WANT_REV)+'&t='+Date.now();
    var x=new XMLHttpRequest();x.open('GET',u,true);x.send(null);
  }catch(e){}
}

try{
  var ml=window.__ModuleLoader__;
  if(!ml||typeof ml.load!=='function'){ report('no-loader'); return }

  // 1. 队列快照（只读）
  try{
    var q=ml.pendingQueue;
    if(Array.isArray(q)){
      var ids=[];
      for(var i=0;i<q.length;i++){ ids.push(String((q[i]&&q[i].id)||'?')) }
      report('queue', 'count='+q.length+' hasMine='+(ids.indexOf(WANT_ID)>=0?'1':'0')+' ids='+ids.slice(0,12).join('|'));
    }else{
      report('queue', 'not-array:'+(typeof q));
    }
  }catch(e){ report('queue-threw',(e&&e.message)||String(e)) }

  // 2. 启动清单里我们那条 entry（只读）
  try{
    var es=(window.__DSH_BOOT__||{}).entries||[];
    for(var j=0;j<es.length;j++){
      if(String(es[j]&&es[j].id)===WANT_ID){
        report('entry', 'url='+String(es[j].url||'')+' rev='+String(es[j].rev||'')+' imm='+String(es[j].immediately));
        break;
      }
    }
  }catch(e){ report('entry-threw',(e&&e.message)||String(e)) }

  // 3. DOM 证据 —— apply 真的跑了的铁证（只读）
  try{
    var d=window.document||document;
    var chip=d.getElementById&&d.getElementById('dsh-term-lens-chip')?'1':'0';
    var style=d.querySelector&&d.querySelector('style[data-plugin-css="dsh-term-lens/styles.css"]')?'1':'0';
    var applied=window.__dshTermLensApplied?'1':'0';
    report('dom', 'chip='+chip+' style='+style+' appliedFlag='+applied);
  }catch(e){ report('dom-threw',(e&&e.message)||String(e)) }

  report('done', 'observation complete');
}catch(e){ report('outer-threw', (e&&e.message)||String(e)) }
});`
}

/**
 * 生成完整注入行：boot 后观测 + boot 后环境探测。
 *
 * **不做任何投递、不做任何重载** —— 见文件头结论。
 *
 * @param {string} stamp
 * @param {{endpoint?: string, targetId?: string, pingPath?: string}} [opts]
 */
export function buildInjectRow(stamp, opts = {}) {
  const endpoint = opts.endpoint ?? '/term-lens/env'
  const targetId = opts.targetId ?? 'dsh-term-lens'
  const pingPath = opts.pingPath ?? '/term-lens/client-ping'
  const probe = buildEnvProbeRow({ endpoint })
  const observation = buildLoaderObservationScript(stamp, targetId, pingPath)
  const probeDeferred = `__tlReady(function(){\n${probe.text}\n});`

  return {
    kind: 'script',
    placement: 'body',
    text: `/* __dsh_term_lens_env_probe */\n${DEFER_PREAMBLE}\n${observation}\n${probeDeferred}`,
  }
}

/**
 * 把注入行挂到 webserver 的 index 注入表上，并返回 disposer。
 *
 * @param {object} ctx
 * @param {object} logger
 */
export function installClientSync(ctx, logger) {
  const source = readClientSource()
  if (!source) {
    logger.warn('[term-lens] 读不到 lib/client.js,跳过页面注入')
    return null
  }
  const stamp = clientBundleStamp(source)
  const row = buildInjectRow(stamp)

  const handler = (table) => {
    try {
      if (!Array.isArray(table)) return
      for (const existing of table) {
        if (existing && existing.kind === 'script' && typeof existing.text === 'string' && existing.text.includes('__dsh_term_lens_env_probe')) {
          return
        }
      }
      table.push(row)
    } catch (err) {
      logger.warn('[term-lens] 注入页面行失败: %s', err?.message ?? err)
    }
  }

  ctx.on('webserver/index-inject', handler)
  logger.info('[term-lens] 页面观测行已挂载 (stamp=%s, client.js %d 字节)', stamp, source.length)

  return () => {
    try {
      ctx.off('webserver/index-inject', handler)
    } catch {
      /* ignore */
    }
  }
}
