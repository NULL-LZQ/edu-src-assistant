// content.js - EDUSRC礼品搜索助手
var added = false;
var cachedData = null;
var searchInput = null;
var searchButton = null;
var originalList = null;
var isSearching = false;

// ---- 过滤开关状态(持久化到storage) ----
var filterSoldOut = false;    // 过滤已兑换:隐藏库存为0/已达兑换上限的礼品
var filterRedeemable = false; // 仅看可兑换:金币够 + 漏洞要求满足 + 未达上限

// ---- 缓存 ----
var giftInfoCache = {};   // 详情缓存 {id:{redeemed,limit,schools,reqType,req,ts}} 持久化到storage(V2:含兑换要求分析)
var userDataCache = null; // 用户数据 {coins,coinsOk,vulns,vulnsOk,ts} 内存10分钟

var SEV = { '低危': 1, '中危': 2, '高危': 3, '严重': 4 };
// 计入兑换资格的漏洞状态(近似平台口径:已收录的漏洞;待审核/未通过不计)
var ACCEPTED_STATUS = ['等待修复', '已修复', '已发布'];

// 从页面解析礼品数据
function parseGiftsFromPage(doc) {
    var gifts = [];
    var items = doc.querySelectorAll('ul li');

    items.forEach(function(item) {
        var link = item.querySelector('a');
        var img = item.querySelector('img');

        if (link) {
            var href = link.getAttribute('href');
            var name = link.textContent.trim();
            var giftId = href ? href.match(/\/gift\/(\d+)/) : null;

            // 获取剩余数量和价格
            var remainText = item.textContent.match(/剩余数量[：:]\s*(\d+)/);
            var priceText = item.textContent.match(/价格[：:]\s*(\d+)/);

            if (name && giftId) {
                gifts.push({
                    id: giftId[1],
                    name: name,
                    url: href,
                    img: img ? img.getAttribute('src') : '',
                    remain: remainText ? parseInt(remainText[1]) : 0,
                    price: priceText ? parseInt(priceText[1]) : 0,
                    // 是否已兑换完：剩余数量为0，或页面直接标注"已兑换"类字样
                    soldOut: remainText ? parseInt(remainText[1]) === 0 : /已兑换完|已兑完|已抢完/.test(item.textContent)
                });
            }
        }
    });

    return gifts;
}

// 获取分页信息
function getPageCount(doc) {
    // 直接在doc中搜索所有包含数字的链接
    var links = doc.querySelectorAll('a[href*="page="]');
    var maxPage = 1;

    console.log("==> 找到page链接数量:", links.length);

    for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href');
        var match = href.match(/page=(\d+)/);
        if (match) {
            var pageNum = parseInt(match[1]);
            console.log("    href:", href, "-> 页码:", pageNum);
            if (pageNum > maxPage) {
                maxPage = pageNum;
            }
        }
    }

    console.log("==> 最终页数:", maxPage);
    return maxPage;
}

//加载所有礼品数据
async function loadAllGifts() {
    console.log("==> 开始加载礼品数据...");

    try {
        // 获取第一页
        var response = await fetch(window.location.pathname);
        var html = await response.text();
        var parser = new DOMParser();
        var doc = parser.parseFromString(html, 'text/html');

        var gifts = parseGiftsFromPage(doc);
        var pageCount = getPageCount(doc);

        console.log("==> 总页数:", pageCount, "第一页礼品数:", gifts.length);

        // 获取剩余页面
        for (var page = 2; page <= pageCount; page++) {
            try {
                var res = await fetch(window.location.pathname + '?page=' + page);
                var h = await res.text();
                var d = parser.parseFromString(h, 'text/html');
                var pageGifts = parseGiftsFromPage(d);
                gifts = gifts.concat(pageGifts);
                console.log("==> 第" + page + "页加载完成,累计:", gifts.length);
            } catch (e) {
                console.log("==> 第" + page + "页加载失败:", e);
            }
        }

        console.log("==> 加载完成，总计:", gifts.length, "条礼品数据");

        // 保存到storage
        cachedData = gifts;
        chrome.storage.local.set({ 'giftCache': gifts }, function() {
            console.log("==>礼品数据已缓存，共", gifts.length, "条");
        });

        return gifts;

    } catch (e) {
        console.log("==> 加载礼品数据失败:", e);
        return [];
    }
}

// 模糊搜索
function fuzzySearch(gifts, keyword) {
    if (!keyword) return gifts;

    var kw = keyword.toLowerCase();
    return gifts.filter(function(gift) {
        return gift.name.toLowerCase().includes(kw);
    });
}

// 判断礼品是否已兑换完(库存维度)
function isSoldOutGift(gift) {
    return gift.soldOut === true;
}

// 从礼品名称提取学校名(作为"来源"字段的补充匹配,学校可能更名)
function extractSchoolFromName(name) {
    var s = (name || '').replace(/^礼品[-—_:]*/, '').replace(/原创漏洞证书/g, '');
    s = s.replace(/(版)?(漏洞报送证书|漏洞报告证书|漏洞挖掘证书|网络安全证书|感谢信|邀请码|电子版).*$/, '');
    s = s.replace(/[-—_\s]/g, '');
    return s;
}

// 分析描述中的兑换要求(严格模式)
// 返回 { type: 'NONE'|'EVALUABLE'|'UNEVALUABLE' }
//   NONE        = 描述中没有任何要求类字样，仅受金币/上限约束
//   EVALUABLE   = 解析出"提交/报送 X个 某校 某等级漏洞(+时间下限)"，可与漏洞列表比对
//   UNEVALUABLE = Rank/分数/积分类条件(如"6rank"、"不低于2分"，漏洞列表无分数数据)，
//                 或描述含要求类字样但句式解析失败 -> 严格起见一律隐藏，避免把不能兑的误报成可兑
// 已知文案变体:
//   "兑换要求至少提交过 1 个南开大学的中危或以上级别漏洞。"
//   "2026年5月1日以后提交过1个中危(或以上级别)漏洞"
//   "至少在2024年4月8号及以后提交陕西铁路工程职业技术学院所属系统1个高危级别或2个中危漏洞"
//   "兑换要求不少于1个学校漏洞"
function analyzeRequirement(desc) {
    if (!desc) return { type: 'NONE' };

    // 找含"漏洞"且有要求类字样的句子
    var seg = null;
    var sentences = desc.split(/[。\n]/);
    for (var i = 0; i < sentences.length; i++) {
        var s = sentences[i];
        if (s.indexOf('漏洞') >= 0 && /(提交|报送|兑换要求|兑换条件|不少于|至少)/.test(s)) {
            seg = s;
            break;
        }
    }

    var hasHint = /(兑换要求|兑换条件|至少|不少于|积分|rank|提交|报送)/i.test(desc);

    if (!seg) {
        return hasHint ? { type: 'UNEVALUABLE' } : { type: 'NONE' };
    }

    // Rank/分数/积分类条件无法从漏洞列表评估 -> 严格隐藏
    if (/rank|\d+\s*分|积分|分数/i.test(seg)) {
        return { type: 'UNEVALUABLE' };
    }

    var req = { count: 1, level: 0, after: null };

    // 数量: "提交/报送...N个" 或 "不少于/至少 N个"，支持中文数字
    var cm = seg.match(/(?:提交|报送)[^。]{0,60}?(\d+|一|两|二|三|四|五)\s*个/);
    if (!cm) cm = seg.match(/(?:不少于|至少)\s*(\d+|一|两|二|三|四|五)\s*个/);
    if (cm) {
        req.count = ({ '一': 1, '两': 2, '二': 2, '三': 3, '四': 4, '五': 5 }[cm[1]]) || parseInt(cm[1]) || 1;
    }

    // 危害等级下限
    var lm = seg.match(/(严重|高危|中危|低危)/);
    if (lm) req.level = SEV[lm[1]];

    // 时间下限: 兼容 "2026年5月1日以后"/"2024年4月8号及以后"/"2025年6月及以后"/"2026年及以后"
    var dm = seg.match(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]?/);
    if (!dm) dm = seg.match(/(\d{4})年(\d{1,2})月/);
    if (!dm) dm = seg.match(/(\d{4})年/);
    if (dm) {
        req.after = new Date(parseInt(dm[1]), dm[2] ? parseInt(dm[2]) - 1 : 0, dm[3] ? parseInt(dm[3]) : 1).getTime();
    }

    return { type: 'EVALUABLE', req: req };
}

// 判断用户漏洞记录是否满足兑换要求
function meetsRequirement(req, schools, vulns) {
    var count = 0;
    for (var i = 0; i < vulns.length; i++) {
        var v = vulns[i];
        if (!v.accepted) continue; // 只统计已收录(等待修复/已修复)的漏洞
        if (req.level > 0 && v.level < req.level) continue;

        // 学校匹配:标题命中"来源"或礼品名提取的学校名任一即可
        var inSchool = schools.length === 0;
        for (var j = 0; j < schools.length; j++) {
            if (schools[j] && v.title.indexOf(schools[j]) >= 0) { inSchool = true; break; }
        }
        if (!inSchool) continue;

        if (req.after && v.ts && v.ts < req.after) continue;
        count++;
        if (count >= req.count) return true;
    }
    return false;
}

// 获取单个礼品详情:兑换限制(已兑/上限) + 来源学校 + 兑换要求分析(严格模式)
async function fetchGiftInfo(giftId, giftName) {
    // 30分钟缓存(持久化,刷新页面不重拉)
    var cached = giftInfoCache[giftId];
    if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
        return cached;
    }

    try {
        var res = await fetch('/gift/' + giftId + '/', { credentials: 'same-origin' });
        if (!res.ok) return null;
        var text = new DOMParser().parseFromString(await res.text(), 'text/html')
            .body.textContent.replace(/\s+/g, ' ');

        var info = { redeemed: 0, limit: 0, schools: [], reqType: 'NONE', req: null, ts: Date.now() };

        // 兑换限制 "已兑/上限"
        var m = text.match(/兑换限制\s*(\d+)\s*\/\s*(\d+)/);
        if (m) {
            info.redeemed = parseInt(m[1]);
            info.limit = parseInt(m[2]);
        }

        // 学校匹配列表:详情页"来源"字段 + 礼品名提取(学校可能更名,如"新疆交通职业学院"->"职业技术大学")
        var sm = text.match(/来源\s+([^\s]+)/);
        if (sm && sm[1]) info.schools.push(sm[1]);
        var ns = extractSchoolFromName(giftName);
        if (ns && info.schools.indexOf(ns) < 0) info.schools.push(ns);

        // 描述 -> 兑换要求分析(严格模式)
        var di = text.indexOf(' 描述 ');
        if (di < 0) di = text.indexOf('描述');
        if (di >= 0) {
            var ri = text.indexOf(' 返回 ', di);
            var desc = text.slice(di + 2, ri > di ? ri : di + 800);
            var an = analyzeRequirement(desc);
            info.reqType = an.type;
            if (an.type === 'EVALUABLE') info.req = an.req;
        }

        giftInfoCache[giftId] = info;
        return info;
    } catch (e) {
        console.log("==> 获取礼品" + giftId + "详情失败:", e);
    }
    return null;
}

// 获取用户数据:金币(/profile/detail/) + 已提交漏洞列表(/profile/post/)
async function fetchUserData() {
    // 10分钟内存缓存
    if (userDataCache && Date.now() - userDataCache.ts < 10 * 60 * 1000) {
        return userDataCache;
    }

    var data = { coins: null, coinsOk: false, vulns: [], vulnsOk: false, ts: 0 };
    try {
        // 1) 金币余额
        var r1 = await fetch('/profile/detail/', { credentials: 'same-origin' });
        if (r1.ok) {
            var t1 = new DOMParser().parseFromString(await r1.text(), 'text/html')
                .body.textContent.replace(/\s+/g, ' ');
            var m1 = t1.match(/金币\s*([\d,]+)\s*个/);
            if (m1) {
                data.coins = parseInt(m1[1].replace(/,/g, ''));
                data.coinsOk = true;
            }
        }

        // 2) 漏洞列表(全部页): 时间 | 标题 | 等级 | 状态 | 操作
        var page = 1;
        while (page <= 40) {
            var r = await fetch('/profile/post/' + (page > 1 ? '?page=' + page : ''), { credentials: 'same-origin' });
            if (!r.ok) break;
            var doc = new DOMParser().parseFromString(await r.text(), 'text/html');
            var addedRows = 0;

            doc.querySelectorAll('table tr').forEach(function(tr) {
                var tds = tr.querySelectorAll('td');
                if (tds.length < 4) return;
                var title = (tds[1].textContent || '').replace(/\s+/g, ' ').trim();
                var level = (tds[2].textContent || '').trim();
                var status = (tds[3].textContent || '').trim();
                if (!title) return;

                var accepted = false;
                for (var s = 0; s < ACCEPTED_STATUS.length; s++) {
                    if (status.indexOf(ACCEPTED_STATUS[s]) >= 0) { accepted = true; break; }
                }

                var ts = 0;
                var dtm = (tds[0].textContent || '').trim().match(/(\d{4})-(\d{2})-(\d{2})/);
                if (dtm) ts = new Date(parseInt(dtm[1]), parseInt(dtm[2]) - 1, parseInt(dtm[3])).getTime();

                data.vulns.push({ title: title, level: SEV[level] || 0, ts: ts, accepted: accepted });
                addedRows++;
            });
            if (addedRows > 0) data.vulnsOk = true;

            // 是否有下一页
            var hasNext = false;
            doc.querySelectorAll('a[href*="page="]').forEach(function(a) {
                var pm = (a.getAttribute('href') || '').match(/page=(\d+)/);
                if (pm && parseInt(pm[1]) === page + 1) hasNext = true;
            });
            if (!hasNext) break;
            page++;
        }

        var acceptedCount = data.vulns.filter(function(v) { return v.accepted; }).length;
        console.log("==> 用户数据: 金币" + data.coins + ", 漏洞" + data.vulns.length + "条(已收录" + acceptedCount + "条,共" + page + "页)");
    } catch (e) {
        console.log("==> 获取用户数据失败:", e);
    }

    data.ts = Date.now();
    userDataCache = data;
    return data;
}

// 简单并发控制
async function runWithConcurrency(items, limit, worker) {
    var index = 0;
    var runners = [];
    var n = Math.min(limit, items.length);

    function runner() {
        return new Promise(function(resolve) {
            async function next() {
                while (index < items.length) {
                    var item = items[index++];
                    await worker(item);
                }
                resolve();
            }
            next();
        });
    }

    for (var i = 0; i < n; i++) {
        runners.push(runner());
    }
    await Promise.all(runners);
}

// 更新状态提示文字
function updateFilterStatus(info) {
    var els = document.querySelectorAll('.gift-filter-status');
    els.forEach(function(el) {
        if (!info) {
            el.textContent = '';
            return;
        }
        if (info.loading) {
            el.textContent = '正在检查兑换条件...';
            return;
        }
        var text = '共 ' + info.shown + ' 件';
        var parts = [];
        if (info.hiddenStock > 0) parts.push('库存为0 ' + info.hiddenStock + ' 件');
        if (info.hiddenQuota > 0) parts.push('已达上限 ' + info.hiddenQuota + ' 件');
        if (info.hiddenCoins > 0) parts.push('金币不足 ' + info.hiddenCoins + ' 件');
        if (info.hiddenReq > 0) parts.push('要求不符 ' + info.hiddenReq + ' 件');
        if (parts.length > 0) text += ' | 已隐藏：' + parts.join('，');
        el.textContent = text;
    });
}

// 根据当前搜索词 + 过滤开关状态,刷新页面显示
async function applyCurrentView() {
    if (isSearching) return;

    var keyword = searchInput ? searchInput.value.trim() : '';
    var anyFilter = filterSoldOut || filterRedeemable;

    // 无搜索词且未开启过滤 -> 恢复原始列表
    if (!keyword && !anyFilter) {
        restoreOriginalList();
        updateFilterStatus(null);
        return;
    }

    isSearching = true;
    try {
        // 强制重新加载最新数据(保证剩余数量准确)
        console.log("==> 正在重新加载数据...");
        cachedData = await loadAllGifts();

        var results = fuzzySearch(cachedData, keyword);
        var hiddenStock = 0, hiddenQuota = 0, hiddenCoins = 0, hiddenReq = 0;

        // 第一层:库存为0的礼品任何情况下都不可兑换
        if (anyFilter) {
            var kept0 = [];
            results.forEach(function(gift) {
                if (isSoldOutGift(gift)) {
                    hiddenStock++;
                } else {
                    kept0.push(gift);
                }
            });
            results = kept0;
        }

        // 第二层:详情检测(兑换限制 + 兑换要求)
        if (results.length > 0 && (filterSoldOut || filterRedeemable)) {
            updateFilterStatus({ loading: true });

            // 并发拉详情读"兑换限制/来源/兑换要求"(并发5,缓存30分钟)
            await runWithConcurrency(results, 5, async function(gift) {
                await fetchGiftInfo(gift.id, gift.name);
            });
            chrome.storage.local.set({ 'giftInfoCacheV2': giftInfoCache });

            // "仅看可兑换"还需要用户数据(金币 + 漏洞记录)
            var user = null;
            if (filterRedeemable) {
                user = await fetchUserData();
            }

            var kept = [];
            results.forEach(function(gift) {
                var info = giftInfoCache[gift.id];

                // 已达兑换上限 => 不能兑换
                if (info && info.limit > 0 && info.redeemed >= info.limit) {
                    hiddenQuota++;
                    return;
                }

                if (filterRedeemable && user) {
                    // 金币不足 => 买不起
                    if (user.coinsOk && user.coins !== null && gift.price > user.coins) {
                        hiddenCoins++;
                        return;
                    }
                    // 兑换要求(严格模式):
                    //   UNEVALUABLE = Rank/分数类或解析不了的要求 -> 无法确认能兑 -> 隐藏
                    //   EVALUABLE   = 与漏洞列表比对,不满足 -> 隐藏
                    //   NONE        = 无漏洞要求,仅金币/上限约束
                    if (user.vulnsOk && info) {
                        if (info.reqType === 'UNEVALUABLE') {
                            hiddenReq++;
                            return;
                        }
                        if (info.reqType === 'EVALUABLE' && !meetsRequirement(info.req, info.schools, user.vulns)) {
                            hiddenReq++;
                            return;
                        }
                    }
                }

                kept.push(gift);
            });
            results = kept;
        }

        console.log("==> 显示" + results.length + "条，隐藏: 库存0-" + hiddenStock + " 上限-" + hiddenQuota + " 金币-" + hiddenCoins + " 要求-" + hiddenReq);
        displayResults(results);
        updateFilterStatus({ shown: results.length, hiddenStock: hiddenStock, hiddenQuota: hiddenQuota, hiddenCoins: hiddenCoins, hiddenReq: hiddenReq });
    } finally {
        isSearching = false;
    }
}

// 执行搜索 -搜索所有分页数据
async function doSearch() {
    await applyCurrentView();
}

// 查找缩略图容器
function findThumbnailsContainer() {
    return document.querySelector('.am-avg-sm-4.am-thumbnails');
}

// 保存原始HTML
var originalThumbnailsHTML = null;

// 显示搜索结果到页面
function displayResults(results) {
    var container = findThumbnailsContainer();
    if (!container) {
        console.log("==> 未找到缩略图容器");
        return;
    }

    // 保存原始内容
    if (!originalThumbnailsHTML) {
        originalThumbnailsHTML = container.innerHTML;
    }

    // 获取原始li的模板
    var templateLi = container.querySelector('li');
    if (!templateLi) {
        console.log("==> 未找到模板li");
        return;
    }

    // 清空容器
    container.innerHTML = '';

    // 空结果提示
    if (results.length === 0) {
        var emptyLi = document.createElement('li');
        emptyLi.style.cssText = 'padding: 40px 20px; text-align: center; color: #999; font-size: 14px; width: 100%;';
        emptyLi.textContent = (filterSoldOut || filterRedeemable) ? '没有符合兑换条件的礼品' : '没有找到匹配的礼品';
        container.appendChild(emptyLi);
        return;
    }

    // 根据模板生成结果
    results.forEach(function(gift) {
        var li = document.createElement('li');
        li.className = templateLi.className;
        li.innerHTML = templateLi.innerHTML;

        // 更新图片
        var img = li.querySelector('img');
        if (img) {
            img.src = gift.img;
        }

        // 更新图片链接
        var imgLink = li.querySelector('.pic a');
        if (imgLink) {
            imgLink.href = gift.url;
        }

        // 更新所有链接的href
        var links = li.querySelectorAll('a');
        links.forEach(function(link) {
            link.href = gift.url;
        });

        // 直接替换innerHTML中的原始文字为新礼品名称
        // 匹配模板中"原创漏洞证书 xxx"这样的模式
        li.innerHTML = li.innerHTML.replace(/原创漏洞证书\s*[^<\s]+[^<]*/, gift.name);
        li.innerHTML = li.innerHTML.replace(/原创漏洞证书-[^<]*/, gift.name);

        // 更新p标签
        var p = li.querySelector('p');
        if (p) {
            p.textContent = '剩余数量： ' + gift.remain + ' | 价格： ' + gift.price;
        }

        container.appendChild(li);
    });

    // 隐藏分页
    var pagination = document.querySelector('.pagination');
    if (pagination) {
        pagination.style.display = 'none';
    }
}

//恢复原始内容
function restoreOriginalList() {
    if (originalThumbnailsHTML) {
        var container = findThumbnailsContainer();
        if (container) {
            container.innerHTML = originalThumbnailsHTML;
        }
        var pagination = document.querySelector('.pagination');
        if (pagination) {
            pagination.style.display = 'block';
        }
    }
}

// 根据开关状态更新按钮样式
function updateFilterToggleStyle() {
    var toggles = document.querySelectorAll('.gift-filter-toggle');
    toggles.forEach(function(t) {
        var on = t.dataset.filterKey === 'redeemable' ? filterRedeemable : filterSoldOut;
        var track = t.querySelector('.gf-track');
        var knob = t.querySelector('.gf-knob');
        if (!track || !knob) return;

        if (on) {
            // 开启态：蓝色高亮，滑块靠右
            t.style.borderColor = '#3498db';
            t.style.background = '#eaf4fd';
            t.style.color = '#2980b9';
            track.style.background = '#3498db';
            knob.style.left = '18px';
        } else {
            // 关闭态：灰色，滑块靠左
            t.style.borderColor = '#e0e0e0';
            t.style.background = '#fafafa';
            t.style.color = '#888';
            track.style.background = '#ccc';
            knob.style.left = '2px';
        }
    });
}

// 创建过滤开关按钮
function createFilterToggle(label, key) {
    var toggle = document.createElement('div');
    toggle.className = 'gift-filter-toggle';
    toggle.dataset.filterKey = key;
    toggle.title = key === 'redeemable'
        ? '开启后只显示：金币够、满足证书漏洞要求、未达兑换上限的礼品'
        : '开启后隐藏库存为0或已达兑换上限的礼品';

    toggle.style.cssText = 'display: inline-flex; align-items: center; margin-left: 8px; padding: 7px 14px; border: 2px solid #e0e0e0; border-radius: 20px; background: #fafafa; color: #888; font-size: 13px; cursor: pointer; user-select: none; vertical-align: middle; transition: all 0.3s ease;';

    // 滑轨
    var track = document.createElement('span');
    track.className = 'gf-track';
    track.style.cssText = 'display: inline-block; width: 34px; height: 18px; border-radius: 9px; background: #ccc; position: relative; transition: all 0.3s ease; flex-shrink: 0;';

    // 滑块
    var knob = document.createElement('span');
    knob.className = 'gf-knob';
    knob.style.cssText = 'position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.25); transition: all 0.3s ease;';

    // 文字
    var txt = document.createElement('span');
    txt.className = 'gf-txt';
    txt.textContent = label;
    txt.style.cssText = 'margin-left: 6px; white-space: nowrap;';

    track.appendChild(knob);
    toggle.appendChild(track);
    toggle.appendChild(txt);

    // 点击切换
    toggle.addEventListener('click', async function() {
        if (isSearching) return;

        if (key === 'redeemable') {
            filterRedeemable = !filterRedeemable;
            chrome.storage.local.set({ 'filterRedeemable': filterRedeemable }, function() {
                console.log("==> 仅看可兑换开关已保存:", filterRedeemable);
            });
        } else {
            filterSoldOut = !filterSoldOut;
            chrome.storage.local.set({ 'filterSoldOut': filterSoldOut }, function() {
                console.log("==> 过滤已兑换开关已保存:", filterSoldOut);
            });
        }
        updateFilterToggleStyle();
        await applyCurrentView();
    });

    return toggle;
}

// 添加搜索框
function addSearchBox() {
    if (added) return;

    // 只在有缩略图容器的页面添加搜索框（排除详情页）
    var container = findThumbnailsContainer();
    if (!container) {
        console.log("==> 当前页面无缩略图容器，不添加搜索框");
        return;
    }

    var h2Elements = document.querySelectorAll('h2');

    for (var i = 0; i < h2Elements.length; i++) {
        // 创建搜索框容器
        var searchWrapper = document.createElement('div');
        searchWrapper.style.cssText = 'display: inline-block; margin-left: 10px; vertical-align: middle;';

        // 创建搜索框
        searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.id = 'gift-search-input';
        searchInput.placeholder = '搜索礼品...';
        searchInput.style.cssText = 'padding: 8px 15px; border: 2px solid #e0e0e0; border-radius: 20px; outline: none; font-size: 14px; width: 180px; transition: all 0.3s ease; background: #fafafa;';

        // 搜索框聚焦样式
        searchInput.addEventListener('focus', function() {
            this.style.borderColor = '#3498db';
            this.style.width = '220px';
            this.style.background = '#fff';
            this.style.boxShadow = '0 0 8px rgba(52, 152, 219, 0.3)';
        });
        searchInput.addEventListener('blur', function() {
            this.style.borderColor = '#e0e0e0';
            this.style.width = '180px';
            this.style.background = '#fafafa';
            this.style.boxShadow = 'none';
        });

        // 创建搜索按钮
        searchButton = document.createElement('button');
        searchButton.id = 'gift-search-btn';
        searchButton.innerHTML = '&#128269;';
        searchButton.style.cssText = 'margin-left: 8px; padding: 8px 16px; border: none; border-radius: 20px; background: linear-gradient(135deg, #3498db, #2980b9); color: white; font-size: 16px; cursor: pointer; transition: all 0.3s ease; box-shadow: 0 2px 5px rgba(0,0,0,0.1);';

        // 搜索按钮悬停样式
        searchButton.addEventListener('mouseover', function() {
            this.style.transform = 'scale(1.05)';
            this.style.boxShadow = '0 4px 10px rgba(52, 152, 219, 0.4)';
        });
        searchButton.addEventListener('mouseout', function() {
            this.style.transform = 'scale(1)';
            this.style.boxShadow = '0 2px 5px rgba(0,0,0,0.1)';
        });
        // 搜索按钮按下样式
        searchButton.addEventListener('mousedown', function() {
            this.style.transform = 'scale(0.95)';
        });
        searchButton.addEventListener('mouseup', function() {
            this.style.transform = 'scale(1.05)';
        });

        // 绑定点击事件
        searchButton.addEventListener('click', doSearch);

        // 绑定回车事件
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                doSearch();
            }
        });

        // 创建两个过滤开关按钮
        var toggleSoldOut = createFilterToggle('过滤已兑换', 'soldOut');
        var toggleRedeemable = createFilterToggle('仅看可兑换', 'redeemable');

        // 创建状态提示
        var statusSpan = document.createElement('span');
        statusSpan.className = 'gift-filter-status';
        statusSpan.style.cssText = 'margin-left: 8px; font-size: 12px; color: #999; vertical-align: middle;';

        // 组装
        searchWrapper.appendChild(searchInput);
        searchWrapper.appendChild(searchButton);
        searchWrapper.appendChild(toggleSoldOut);
        searchWrapper.appendChild(toggleRedeemable);
        searchWrapper.appendChild(statusSpan);

        // 在h2后面追加
        h2Elements[i].insertAdjacentElement('afterend', searchWrapper);
    }

    if (h2Elements.length > 0) {
        added = true;
        // 同步一次开关样式(页面刷新后恢复上次状态)
        updateFilterToggleStyle();
    }
}

// 初始化
addSearchBox();

// 监听DOM变化
var observer = new MutationObserver(function(mutations, obs) {
    if (!added) {
        addSearchBox();
    }
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});

// 页面加载完成后预加载数据
window.addEventListener('load', function() {
    setTimeout(function() {
        chrome.storage.local.get(['giftCache', 'filterSoldOut', 'filterRedeemable', 'giftInfoCacheV2'], function(data) {
            // 恢复详情缓存
            if (data.giftInfoCacheV2 && typeof data.giftInfoCacheV2 === 'object') {
                giftInfoCache = data.giftInfoCacheV2;
                console.log("==> 已恢复礼品详情缓存:", Object.keys(giftInfoCache).length, "条");
            }

            // 恢复过滤开关状态
            if (typeof data.filterSoldOut === 'boolean') filterSoldOut = data.filterSoldOut;
            if (typeof data.filterRedeemable === 'boolean') filterRedeemable = data.filterRedeemable;
            updateFilterToggleStyle();

            // 任一开关开启过 -> 自动应用(内部会重新加载最新数据)
            if (filterSoldOut || filterRedeemable) {
                console.log("==> 已恢复过滤开关: 过滤已兑换=" + filterSoldOut + ", 仅看可兑换=" + filterRedeemable);
                applyCurrentView();
                return;
            }

            // 否则按原逻辑预加载缓存
            if (!data.giftCache || data.giftCache.length === 0) {
                console.log("==> 开始预加载所有分页数据...");
                loadAllGifts();
            } else {
                console.log("==> 使用缓存数据，共", data.giftCache.length, "条");
                cachedData = data.giftCache;
            }
        });
    }, 1000);
});
