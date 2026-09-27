// content.js - EDUSRC礼品搜索助手
var added = false;
var cachedData = null;
var searchInput = null;
var searchButton = null;
var originalList = null;
var isSearching = false;
var filterSoldOut = false; // 过滤已兑换开关状态(持久化到storage)
var quotaCache = {}; // 兑换限制缓存 {giftId: {redeemed, limit, ts}}(持久化到storage)

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

// 判断礼品是否已兑换完
function isSoldOutGift(gift) {
    return gift.soldOut === true;
}

// 从订单页(/profile/order/)解析兑换记录,仅用于统计展示:返回 {active: 有效订单数, cancelled: 撤销订单数}
// 注意:订单页链接是 /gift/order/<订单ID>/,不含礼品ID,无法直接映射礼品,故不做过滤依据
async function fetchOrderStats() {
    var stats = { active: 0, cancelled: 0, names: [] };
    try {
        var res = await fetch('/profile/order/', { credentials: 'same-origin' });
        if (!res.ok) {
            console.log("==> 订单页请求失败:", res.status);
            return stats;
        }
        var html = await res.text();
        var doc = new DOMParser().parseFromString(html, 'text/html');

        doc.querySelectorAll('table tr').forEach(function(tr) {
            var tds = tr.querySelectorAll('td');
            if (tds.length < 4) return;
            var name = (tds[1].textContent || '').trim();
            if (!name || name === '商品') return;
            var status = (tds[3].textContent || '').trim();
            if (status === '撤销') {
                stats.cancelled++;
            } else {
                stats.active++;
                stats.names.push(name);
            }
        });
        console.log("==> 订单解析完成: 有效" + stats.active + "单, 撤销" + stats.cancelled + "单");
    } catch (e) {
        console.log("==> 获取兑换订单失败:", e);
    }
    return stats;
}

// 获取单个礼品的兑换限制"已兑/上限"(详情页"兑换限制"字段,如 0/1;第一位是当前用户已兑次数)
async function fetchGiftQuota(giftId) {
    // 30分钟缓存(已兑次数只有再次兑换才会变)
    var cached = quotaCache[giftId];
    if (cached && Date.now() - cached.ts < 30 * 60 * 1000) {
        return cached;
    }

    try {
        var res = await fetch('/gift/' + giftId + '/', { credentials: 'same-origin' });
        if (!res.ok) return null;
        var html = await res.text();
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var m = doc.body.textContent.match(/兑换限制[：:]?\s*(\d+)\s*\/\s*(\d+)/);
        if (m) {
            var quota = { redeemed: parseInt(m[1]), limit: parseInt(m[2]), ts: Date.now() };
            quotaCache[giftId] = quota;
            // 持久化,避免每次刷新页面都重新拉详情
            chrome.storage.local.set({ 'quotaCache': quotaCache });
            return quota;
        }
        console.log("==> 礼品" + giftId + "详情页未找到兑换限制字段");
    } catch (e) {
        console.log("==> 获取礼品" + giftId + "兑换限制失败:", e);
    }
    return null;
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

// 更新状态提示文字(显示多少件/隐藏多少件)
function updateFilterStatus(info) {
    var els = document.querySelectorAll('.gift-filter-status');
    els.forEach(function(el) {
        if (!info) {
            el.textContent = '';
            return;
        }
        if (info.loading) {
            el.textContent = '正在检查兑换限制...';
            return;
        }
        var text = '共 ' + info.shown + ' 件';
        var parts = [];
        if (info.hiddenStock > 0) parts.push('库存为0 ' + info.hiddenStock + ' 件');
        if (info.hiddenQuota > 0) parts.push('已达兑换上限 ' + info.hiddenQuota + ' 件');
        if (parts.length > 0) text += ' | 已隐藏：' + parts.join('，');
        el.textContent = text;
    });
}

// 根据当前搜索词 + 过滤开关状态,刷新页面显示
async function applyCurrentView() {
    if (isSearching) return;

    var keyword = searchInput ? searchInput.value.trim() : '';

    // 无搜索词且未开启过滤 -> 恢复原始列表
    if (!keyword && !filterSoldOut) {
        restoreOriginalList();
        updateFilterStatus(null);
        return;
    }

    isSearching = true;
    try {
        // 强制重新加载最新数据(保证剩余数量/已兑换状态准确)
        console.log("==> 正在重新加载数据...");
        cachedData = await loadAllGifts();

        var results = fuzzySearch(cachedData, keyword);
        var hiddenStock = 0;
        var hiddenQuota = 0;

        if (filterSoldOut) {
            // 第一层:库存为0(已兑换完)的过滤
            var kept = [];
            results.forEach(function(gift) {
                if (isSoldOutGift(gift)) {
                    hiddenStock++;
                } else {
                    kept.push(gift);
                }
            });
            results = kept;

            if (results.length > 0) {
                // 第二层:兑换限制过滤
                // 详情页"兑换限制 已兑/上限"由服务端按个人订单统计(撤销单已扣除),比订单页映射更准
                updateFilterStatus({ loading: true });

                // 订单统计仅作控制台参考
                fetchOrderStats();

                // 并发拉详情读取"兑换限制"(并发3,30分钟缓存)
                await runWithConcurrency(results, 3, async function(gift) {
                    await fetchGiftQuota(gift.id);
                });

                // 限兑上限 - 已兑次数 <= 0 => 不能再兑换 => 隐藏
                kept = [];
                results.forEach(function(gift) {
                    var q = quotaCache[gift.id];
                    if (q && q.limit > 0 && q.redeemed >= q.limit) {
                        hiddenQuota++;
                    } else {
                        kept.push(gift);
                    }
                });
                results = kept;
            }
        }

        console.log("==> 显示" + results.length + "条结果，隐藏库存为0:" + hiddenStock + "条，隐藏已达上限:" + hiddenQuota + "条");
        displayResults(results);
        updateFilterStatus({ shown: results.length, hiddenStock: hiddenStock, hiddenQuota: hiddenQuota });
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
        emptyLi.textContent = filterSoldOut ? '没有可兑换的礼品（库存为0或已达兑换上限的已隐藏）' : '没有找到匹配的礼品';
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

// 根据开关状态更新"过滤已兑换"按钮样式
function updateFilterToggleStyle() {
    var toggles = document.querySelectorAll('.gift-filter-toggle');
    toggles.forEach(function(t) {
        var track = t.querySelector('.gf-track');
        var knob = t.querySelector('.gf-knob');
        if (!track || !knob) return;

        if (filterSoldOut) {
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

// 创建"过滤已兑换"开关按钮
function createFilterToggle() {
    var toggle = document.createElement('div');
    toggle.className = 'gift-filter-toggle';
    toggle.title = '开启后隐藏库存为0，或个人已兑换数量达到限兑上限的礼品';

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
    txt.textContent = '过滤已兑换';
    txt.style.cssText = 'margin-left: 6px; white-space: nowrap;';

    track.appendChild(knob);
    toggle.appendChild(track);
    toggle.appendChild(txt);

    // 点击切换
    toggle.addEventListener('click', async function() {
        if (isSearching) return;

        filterSoldOut = !filterSoldOut;
        chrome.storage.local.set({ 'filterSoldOut': filterSoldOut }, function() {
            console.log("==> 过滤已兑换开关已保存:", filterSoldOut);
        });
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

        // 创建"过滤已兑换"开关按钮
        var filterToggle = createFilterToggle();

        // 创建状态提示
        var statusSpan = document.createElement('span');
        statusSpan.className = 'gift-filter-status';
        statusSpan.style.cssText = 'margin-left: 8px; font-size: 12px; color: #999; vertical-align: middle;';

        // 组装
        searchWrapper.appendChild(searchInput);
        searchWrapper.appendChild(searchButton);
        searchWrapper.appendChild(filterToggle);
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
        chrome.storage.local.get(['giftCache', 'filterSoldOut', 'quotaCache'], function(data) {
            // 恢复兑换限制缓存
            if (data.quotaCache && typeof data.quotaCache === 'object') {
                quotaCache = data.quotaCache;
                console.log("==> 已恢复兑换限制缓存:", Object.keys(quotaCache).length, "条");
            }

            // 恢复过滤开关状态
            if (typeof data.filterSoldOut === 'boolean') {
                filterSoldOut = data.filterSoldOut;
                updateFilterToggleStyle();
                console.log("==> 已恢复过滤开关状态:", filterSoldOut);
            }

            // 若上次开启过过滤，直接应用(内部会重新加载最新数据)
            if (filterSoldOut) {
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
