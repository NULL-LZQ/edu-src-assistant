// content.js - EDUSRC礼品搜索助手
var added = false;
var cachedData = null;
var searchInput = null;
var searchButton = null;
var originalList = null;
var isSearching = false;

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

// 执行搜索 -搜索所有分页数据
async function doSearch() {
    var keyword = searchInput.value.trim();

    if (!keyword) {
        restoreOriginalList();
        return;
    }

    // 强制重新加载最新数据
    console.log("==> 正在重新加载数据...");
    cachedData = await loadAllGifts();

    // 搜索缓存数据
    var results = fuzzySearch(cachedData, keyword);
    console.log("==>搜索'" + keyword + "'，找到" + results.length + "条结果");
    displayResults(results);
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

        // 组装
        searchWrapper.appendChild(searchInput);
        searchWrapper.appendChild(searchButton);

        // 在h2后面追加
        h2Elements[i].insertAdjacentElement('afterend', searchWrapper);
    }

    if (h2Elements.length > 0) {
        added = true;
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
        chrome.storage.local.get('giftCache', function(data) {
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