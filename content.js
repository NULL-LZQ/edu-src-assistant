// content.js - EDUSRC礼品搜索助手
var added = false;
var cachedData = null;
var searchInput = null;
var searchButton = null;
var statusEl = null;
var debounceTimer = null;
var loadPromise = null;

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
                    price: priceText ? parseInt(priceText[1]) : 0
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

    // 无匹配结果时给出提示
    if (!results.length) {
        container.innerHTML = '<li style="list-style:none; width:100%; padding:24px 0; text-align:center; color:#999; font-size:14px;">未找到相关礼品</li>';
        var emptyPagination = document.querySelector('.pagination');
        if (emptyPagination) {
            emptyPagination.style.display = 'none';
        }
        return;
    }

    // 获取原始li的模板
    var templateLi = container.querySelector('li');
    if (!templateLi) {
        console.log("==> 未找到模板li");
        return;
    }

    // 清空容器
    container.innerHTML = '';

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

// 输入防抖：停止输入 250ms 后自动搜索
function onInputChange() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doLiveSearch, 250);
}

// 确保全量礼品数据已加载（同一时间只加载一次）
function ensureDataLoaded() {
    if (cachedData && cachedData.length) {
        return Promise.resolve(cachedData);
    }
    if (loadPromise) {
        return loadPromise;
    }

    updateStatus('正在加载全部礼品数据…');

    loadPromise = loadAllGifts().then(function(data) {
        cachedData = data || [];
    }).catch(function(e) {
        console.log("==> 数据加载失败:", e);
        cachedData = [];
    }).then(function() {
        loadPromise = null;
        // 加载结束后，如果用户当前没有输入关键词，就清掉"正在加载"提示
        if (!searchInput || !searchInput.value.trim()) {
            updateStatus('');
        }
        return cachedData;
    });

    return loadPromise;
}

// 实时搜索：输入即筛选，无需点击
async function doLiveSearch() {
    if (!searchInput) return;

    var keyword = searchInput.value.trim();

    if (!keyword) {
        restoreOriginalList();
        updateStatus('');
        return;
    }

    var data = await ensureDataLoaded();

    // 等待期间输入可能已变化，重新读取一次
    keyword = searchInput.value.trim();
    if (!keyword) {
        restoreOriginalList();
        updateStatus('');
        return;
    }

    var results = fuzzySearch(data, keyword);
    console.log("==> 搜索'" + keyword + "'，找到" + results.length + "条结果");
    displayResults(results);
    updateStatus('找到 ' + results.length + ' 条结果');
}

// 更新搜索状态提示
function updateStatus(text) {
    if (statusEl) {
        statusEl.textContent = text || '';
    }
}

// 添加搜索框（站点原生风格，只在标题后插入一次）
function addSearchBox() {
    if (added) return;

    // 只在有缩略图容器的页面添加搜索框（排除详情页）
    var container = findThumbnailsContainer();
    if (!container) {
        console.log("==> 当前页面无缩略图容器，不添加搜索框");
        return;
    }

    var title = document.querySelector('h2');
    if (!title) {
        console.log("==> 未找到标题，暂不添加搜索框");
        return;
    }

    // 外层容器：输入框与按钮拼成一个整体
    // position+z-index：页面首屏渲染时证书列表（.pic 为 position:relative）会短暂上移压到搜索框，
    // 这里让搜索框始终绘制在证书之上，避免被遮挡
    var wrapper = document.createElement('span');
    wrapper.id = 'gift-search-wrapper';
    wrapper.style.cssText = 'position: relative; z-index: 50; display: inline-flex; align-items: center; vertical-align: middle; margin-left: 12px;';

    // 输入框
    searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.id = 'gift-search-input';
    searchInput.placeholder = '输入关键词，实时筛选礼品…';
    searchInput.autocomplete = 'off';
    searchInput.style.cssText = 'box-sizing: border-box; height: 34px; width: 220px; padding: 0 12px; font-size: 13px; color: #333; background: #fff; border: 1px solid #ccc; border-right: none; border-radius: 3px 0 0 3px; outline: none; transition: border-color 0.2s ease;';
    searchInput.addEventListener('focus', function() {
        this.style.borderColor = '#0e90d2';
    });
    searchInput.addEventListener('blur', function() {
        this.style.borderColor = '#ccc';
    });

    // 搜索按钮
    searchButton = document.createElement('button');
    searchButton.type = 'button';
    searchButton.id = 'gift-search-btn';
    searchButton.style.cssText = 'box-sizing: border-box; display: inline-flex; align-items: center; gap: 5px; height: 34px; padding: 0 14px; font-size: 13px; color: #fff; background: #0e90d2; border: 1px solid #0e90d2; border-radius: 0 3px 3px 0; cursor: pointer; transition: background 0.2s ease;';
    searchButton.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="16.5" y1="16.5" x2="21" y2="21"></line></svg><span>搜索</span>';
    searchButton.addEventListener('mouseover', function() {
        this.style.background = '#0a7ab8';
        this.style.borderColor = '#0a7ab8';
    });
    searchButton.addEventListener('mouseout', function() {
        this.style.background = '#0e90d2';
        this.style.borderColor = '#0e90d2';
    });

    // 状态提示（加载中 / 结果数量）
    statusEl = document.createElement('span');
    statusEl.id = 'gift-search-status';
    statusEl.style.cssText = 'margin-left: 10px; font-size: 12px; color: #888; vertical-align: middle;';

    // 实时搜索：输入即筛选
    searchInput.addEventListener('input', onInputChange);
    searchInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            clearTimeout(debounceTimer);
            doLiveSearch();
        }
        if (e.key === 'Escape') {
            this.value = '';
            restoreOriginalList();
            updateStatus('');
        }
    });

    // 点击按钮立即搜索（跳过防抖）
    searchButton.addEventListener('click', function() {
        clearTimeout(debounceTimer);
        doLiveSearch();
    });

    wrapper.appendChild(searchInput);
    wrapper.appendChild(searchButton);
    wrapper.appendChild(statusEl);
    title.insertAdjacentElement('afterend', wrapper);

    added = true;
}

// 初始化
addSearchBox();

// 监听DOM变化
var observer = new MutationObserver(function() {
    if (!added) {
        addSearchBox();
    }
});

observer.observe(document.body, {
    childList: true,
    subtree: true
});

// 页面加载完成后在后台预加载全量数据，让首次输入即可秒出结果
function schedulePrefetch() {
    var run = function() {
        ensureDataLoaded().then(function(data) {
            console.log("==> 数据就绪，共", data.length, "条");
            // 若用户在加载完成前已输入，补一次搜索
            if (searchInput && searchInput.value.trim()) {
                doLiveSearch();
            }
        });
    };

    // 等首屏资源（证书图片）加载稳定后再后台预取，避免抢带宽造成首屏卡顿
    if (window.requestIdleCallback) {
        window.requestIdleCallback(run, { timeout: 3000 });
    } else {
        setTimeout(run, 1500);
    }
}

window.addEventListener('load', function() {
    setTimeout(schedulePrefetch, 800);
});
