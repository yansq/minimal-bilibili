import $, { Cash } from 'cash-dom';
import delegate from 'delegate-it';

import { loadSettings } from './settings';
import { colors, getLogger } from './utils/log';
import { formatDate, formatDuration, hoursOrMinutesFrom } from './utils/misc';


/*
possible settings:
- [x] enable/disable scroll to load
- [x] enable/disable auto focus search bar
- [ ] enable/disable hover seq to show preview
- [ ] feed font size

TODO:
- [x] hover seq number to show preview
- [ ] remember watched status in local storage
- [ ] add toggle to show/hide watched videos
- [ ] list: rightmost button that marks watched/unwatched, and shows preview
- [ ] play-controls: mark watched/unwatched
- [ ] paginator: next/prev video, close button in the middle
- [ ] error handling for video page parsing
- [ ] column for recommendations
- [ ] like, tip, fav buttons
- [ ] add video to bilibili history
*/


const lg = getLogger('content_script', colors.bgYellowBright)
lg.info('content_script.ts');

const TYPE_LIST = {
  VIDEO: '8',
  BANGUMI: '512,4097,4098,4099,4100,4101',
}
const MAX_RECOMMEND_ITEMS = 9
const WATCH_LATER_URL = 'https://www.bilibili.com/watchlater/list?spm_id_from=333.1007.0.0#/list'
const HISTORY_CURSOR_URL = 'https://api.bilibili.com/x/web-interface/history/cursor'
const WATCH_LATER_API_URL = 'https://api.bilibili.com/x/v2/history/toview'
const WATCH_LATER_ADD_API_URL = 'https://api.bilibili.com/x/v2/history/toview/add'
const WATCH_LATER_REMOVE_API_URL = 'https://api.bilibili.com/x/v2/history/toview/del'
const HISTORY_PAGE_SIZE = 30
const MAX_HISTORY_PAGES = 20

/* main */

loadSettings().then((settings) => {
  lg.info('loaded settings', settings)
  const blockedWords = settings.blockedWords
    ? settings.blockedWords
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  console.log("Processed blockedWords:", blockedWords);

  if (settings.showRecommend) {
    lg.info('showRecommend is enabled')

    // show recommend
    const recContainer = $('.recommended-container_floor-aside')
    $('<div class="section-title">').text('推荐').prependTo(recContainer)
    observeRecommend(blockedWords)
  }

  setTimeout(() => {
    const searchInput = document.querySelector('input.nav-search-input') as HTMLInputElement
    // remove placeholder and title
    searchInput.placeholder = ''
    searchInput.title = ''
    initSearchFocusProxy(searchInput)
    initHomeSummaryPanel()
    // focus
    if (settings.autoFocusSearchBar) {
      searchInput.focus()
    }
  }, 1000);

  // remove download button
  const downloadLink = document.querySelector('.download-client-trigger')
  downloadLink?.parentElement?.remove()

  // all the logics that rely on uid
  const uidInterval = setInterval(() => {
    // keep trying to get profile link
    const profileLink = document.querySelector('.header-entry-mini') as HTMLLinkElement
    if (!profileLink) {
      return
    }

    clearInterval(uidInterval)

    // get uid
    const uidRegex = /space\.bilibili\.com\/(\d+)/
    const uid = profileLink.href.match(uidRegex)![1]
    // console.log('uid', uid)

    // create container
    const dynamicsParent = $('.feed2')
    const container = $('<div class="dynamics-container">').prependTo(dynamicsParent)
    const watchLaterState = createWatchLaterState()

    // init columns
    const loadMoreFuncs: Array<() => Promise<void>> = []


    const loadMoreVideos = initDynamicsColumn(container, 'left', '动态', uid, TYPE_LIST.VIDEO, blockedWords, watchLaterState)
    if (settings.autoLoadVideoColumn)
      loadMoreFuncs.push(loadMoreVideos)

    // add video to watch later
    delegate(container.get(0) as HTMLDivElement, '.left-column .dynamic-item .watch-later-button', 'click', async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const button = (e.target as HTMLElement).closest('.watch-later-button') as HTMLButtonElement|null
      if (!button) return
      const bvid = button.dataset.bvid
      const aid = button.dataset.aid
      if (!bvid || button.disabled) return

      const shouldRemove = button.dataset.watchLaterState === 'saved'
      setWatchLaterButtonState(button, shouldRemove ? 'removing' : 'saving')
      try {
        if (shouldRemove) {
          if (!aid) throw new Error('缺少视频 aid，无法取消保存')
          await removeFromWatchLater(aid)
          unmarkBvidAsWatchLater(watchLaterState, bvid)
          setWatchLaterButtonState(button, 'idle')
        } else {
          await addToWatchLater(bvid)
          markBvidAsWatchLater(watchLaterState, bvid)
          setWatchLaterButtonState(button, 'saved')
        }
      } catch (error) {
        console.error('update watch later failed', error)
        const fallbackMessage = shouldRemove ? '取消保存失败' : '保存失败'
        setWatchLaterButtonState(button, 'error', error instanceof Error ? error.message : fallbackMessage)
      }
    })

    // load more when scroll to bottom
    detectScrollToBottom(async () => {
      if (loadMoreFuncs.length === 0) return
      await Promise.all(loadMoreFuncs.map(f => f()))
    })
  }, 100)
})

/* functions */

async function fetchDynamics(uid: string, dynamicId: string|null, type_list: string): Promise<DynamicData> {
  // see https://github.com/SocialSisterYi/bilibili-API-collect/blob/master/docs/dynamic/get_dynamic_detail.md
  // for type_list values meaning
  let url
  if (dynamicId) {
    url = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/dynamic_history?uid=${uid}&type_list=${type_list}&offset_dynamic_id=${dynamicId}`
  } else {
    url = `https://api.vc.bilibili.com/dynamic_svr/v1/dynamic_svr/dynamic_new?uid=${uid}&type_list=${type_list}`
  }

  const resp = await fetch(url, {
    credentials: 'include',
  })
  return resp.json()
}

interface DynamicData {
  data: {
    cards: {
      card: string
      desc: {
        // video id, e.g. BV1Dx4y1F7u3; video url: https://www.bilibili.com/video/BV1Dx4y1F7u3
        bvid: string
        dynamic_id_str: string
        // e.g. 1677212231
        timestamp: number
        user_profile?: {
          info: {
            // avatar image url
            face: string
            // user id, e.g. 31700507; user url: https://space.bilibili.com/31700507
            uid: number
            uname: string
          }
        }
      }
      display: any
      extend_json: string
    }[]
  }
}

interface VideoCard {
  // video av id, used by some history/watchlater APIs
  aid: number
  // 【游研社】在末日生存如何解决“住房”问题？
  title: string
  // "在当今的文化作品中，末日题材已越发被大家熟悉。丧尸、核平、冻土、水灾......在这些诸多的末日题材中，总有那么一群生存大师，即便身处的环境再差，也要想办法给自己解决“住房”问题。今天我们就来和大家聊聊末日生存该如何解决“住”的问题。"
  desc: string
  // e.g. 1677212230
  // NOTE pubdate may be earlier than the actual time the video appears in dynamics, use desc.timestamp instead
  pubdate: number
  // duration in seconds
  duration: number
  // video thumbnail url
  pic: string
  // statistics
  stat: {
    like: number
    coin: number
    favorite: number
    reply: number
    view: number
  }
  // tag name, e.g. 单机游戏
  tname: string
  // tag id
  tid: number
}

interface BangumiCard {
  new_desc: string
  cover: string
  apiSeasonInfo: {
    title: string
    cover: string
  }
  url: string
}

interface ColumnState {
  dynamicsSeq: number
  lastDynamicId: string|null
}

interface HistoryCursor {
  max: number
  view_at: number
  business: string
}

interface HistoryItem {
  duration: number
  progress: number
  view_at: number
}

interface HistoryData {
  code: number
  message: string
  data: {
    cursor: HistoryCursor
    list: HistoryItem[]
  }
}

interface TodayWatchStats {
  count: number
  seconds: number
}

interface WatchLaterItem {
  bvid: string
}

interface WatchLaterData {
  code: number
  message: string
  data: {
    list?: WatchLaterItem[]
  }
}

interface WatchLaterState {
  bvids: Set<string>|null
  pendingSavedBvids: Set<string>
  promise: Promise<Set<string>>
}

function initDynamicsColumn(container: Cash, name: string, title: string, uid: string, type_list: string, blockedWords: string[], watchLaterState: WatchLaterState) {

  const column = $(`<section class="${name}-column">`).appendTo(container)
  $('<div class="section-title">').text(title).appendTo(column)
  const items = $('<div class="items">').appendTo(column)
  const actions = $('<div class="actions">').appendTo(column)
  const loadMore = $('<button class="load-more button">').text('加载更多').appendTo(actions)

  const state: ColumnState = {
    dynamicsSeq: 0,
    lastDynamicId: null,
  }

  const loadMoreFunc = async () => {
    loadMore.attr('disabled', 'disabled')
    await loadDynamics(state, items, uid, type_list, blockedWords, watchLaterState)
    loadMore.removeAttr('disabled')
  }

  loadMore.on('click', loadMoreFunc)

  loadDynamics(state, items, uid, type_list, blockedWords, watchLaterState)
  return loadMoreFunc
}

async function loadDynamics(state: ColumnState, container: Cash, uid: string, type_list: string, blockedWords: string[], watchLaterState: WatchLaterState) {

  return fetchDynamics(uid, state.lastDynamicId, type_list).then(data => {
    // console.log('data', data)
    for (const item of data.data.cards) {
      state.dynamicsSeq++
      const desc = item.desc
      const _card = JSON.parse(item.card)
      let innerHtml
      let dateStr
      if (desc.bvid) {
        const card = _card as VideoCard
        let shouldBlock = false
        for (const word of blockedWords) {
          if (card.title.toLowerCase().includes(word.toLowerCase())) {
            console.log(`block video with title ${card.title}, match word ${word}`)
            shouldBlock = true
            break
          }
        }
        if (shouldBlock) continue

        const description = card.desc
        innerHtml = `
          <a href="https://www.bilibili.com/video/${desc.bvid}" target="_blank" class="seq">${state.dynamicsSeq}</a>
          ${divPreview(card.pic, description)}
          <div class="content">
            <div class="title">
              <a href="https://www.bilibili.com/video/${desc.bvid}" target="_blank">${card.title}</a>
            </div>
            <div class="meta">
              <span class="with-sep">${spanIcon('user')}<a href="https://space.bilibili.com/${desc.user_profile?.info.uid}" target="_blank">${desc.user_profile?.info.uname}</a></span
              ><span class="with-sep">${spanIcon('calendar-time')}${hoursOrMinutesFrom(desc.timestamp)}</span
              ><span class="with-sep">${spanIcon('clock')}${formatDuration(card.duration)}</span
              ><span class="stats">
                ${spanIcon('thumb-up')}<span class="value">${card.stat.like}</span>
                ${spanIcon('coin-yuan')}<span class="value">${card.stat.coin}</span>
                ${spanIcon('star')}<span class="value">${card.stat.favorite}</span>
              </span
              ><button type="button" class="watch-later-button" data-bvid="${desc.bvid}" data-aid="${card.aid}" title="保存到稍后再看">
                ${spanIcon('clock')}<span>稍后再看</span>
              </button>
            </div>
            <div class="desc">${description}</div>
          </div>
        `
        dateStr = formatDate(desc.timestamp)
      } else {
        const card = _card as BangumiCard
        const description = card.apiSeasonInfo.title
        // console.log('bangumi card', card, item)
        innerHtml = `
          <a href="https://www.bilibili.com/video/${desc.bvid}" target="_blank" class="seq">${state.dynamicsSeq}</a>
          ${divPreview(card.cover, description)}
          <div class="content">
            <div class="title">
              <a href="${card.url}" target="_blank">${card.new_desc}</a>
            </div>
            <div class="meta">
              <span class="with-sep">${spanIcon('user')}${card.apiSeasonInfo.title}</span
              ><span>${spanIcon('calendar-time')}${hoursOrMinutesFrom(desc.timestamp)}</span
            </div>
            <div class="desc">${description}</div>
          </div>
        `
        dateStr = formatDate(desc.timestamp)
      }

      // get or create date separator
      const dateSeparator = container.find(`.date-separator[data-date="${dateStr}"]`)
      if (dateSeparator.length === 0) {
        $(`<div class="date-separator" data-date="${dateStr}"><span>${dateStr}</span></div>`).appendTo(container)
      }

      const dynamicItem = $('<div class="dynamic-item">').appendTo(container)
      dynamicItem.html(innerHtml)

      state.lastDynamicId = desc.dynamic_id_str
    }
    syncWatchLaterButtons(container, watchLaterState)
  })
}

function spanIcon(icon: string) {
  return `<span class="icon icon--tabler icon--tabler--${icon}"></span>`
}

function initSearchFocusProxy(searchInput: HTMLInputElement) {
  const searchContainer = $(searchInput).closest('.center-search-container').get(0)
  if (!searchContainer || searchContainer.dataset.minimalBilibiliFocusProxy === '1') return

  searchContainer.dataset.minimalBilibiliFocusProxy = '1'
  searchContainer.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (target.closest('button, a')) return
    searchInput.focus()
  })
}

function initHomeSummaryPanel() {
  if ($('.home-summary-panel').length > 0) return

  const panel = $(`
    <div class="home-summary-panel">
      <a class="watch-later-page-link button" href="${WATCH_LATER_URL}">
        ${spanIcon('clock')}<span>稍后再看</span>
      </a>
      <div class="today-watch-stats" title="按 B 站观看历史统计">
        ${spanIcon('clock')}<span>今日已看：统计中...</span>
      </div>
    </div>
  `).appendTo(document.body)

  const statsEl = panel.find('.today-watch-stats span:last-child').get(0)
  if (!statsEl) return

  loadTodayWatchStats()
    .then((stats) => {
      statsEl.textContent = `今日已看：${stats.count} 个 / ${formatWatchSeconds(stats.seconds)}`
    })
    .catch((error) => {
      console.error('load today watch stats failed', error)
      statsEl.textContent = '今日已看：统计失败'
    })
}

function divPreview(img: string, desc: string) {
  return `
    <div class="preview">
      <div class="inner">
        <img src="${img}">
        <div class="desc">简介: ${desc}</div>
      </div>
    </div>
  `
}

async function loadTodayWatchStats(): Promise<TodayWatchStats> {
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const todayStartSeconds = Math.floor(startOfToday.getTime() / 1000)
  let cursor: HistoryCursor|null = null
  let count = 0
  let seconds = 0

  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    const data: HistoryData = await fetchHistoryPage(cursor)
    const items = data.data?.list || []
    if (items.length === 0) break

    for (const item of items) {
      if (item.view_at < todayStartSeconds) {
        return { count, seconds }
      }

      count++
      seconds += watchedSecondsFromHistoryItem(item)
    }

    cursor = data.data.cursor
    if (!cursor || cursor.view_at < todayStartSeconds) break
  }

  return { count, seconds }
}

async function fetchHistoryPage(cursor: HistoryCursor|null): Promise<HistoryData> {
  const url = new URL(HISTORY_CURSOR_URL)
  url.searchParams.set('ps', String(HISTORY_PAGE_SIZE))
  url.searchParams.set('type', 'archive')
  if (cursor) {
    url.searchParams.set('max', String(cursor.max))
    url.searchParams.set('view_at', String(cursor.view_at))
    url.searchParams.set('business', cursor.business)
  }

  const resp = await fetch(url.toString(), {
    credentials: 'include',
  })
  const data = await resp.json()
  if (data.code !== 0) {
    throw new Error(data.message || '获取观看历史失败')
  }
  return data
}

function watchedSecondsFromHistoryItem(item: HistoryItem) {
  if (item.progress === -1) return item.duration
  if (item.duration > 0) return Math.min(item.progress, item.duration)
  return Math.max(item.progress, 0)
}

function formatWatchSeconds(seconds: number) {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} 分钟`

  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (restMinutes === 0) return `${hours} 小时`
  return `${hours} 小时 ${restMinutes} 分钟`
}

function createWatchLaterState(): WatchLaterState {
  const state: WatchLaterState = {
    bvids: null,
    pendingSavedBvids: new Set(),
    promise: Promise.resolve(new Set<string>()),
  }

  state.promise = fetchWatchLaterBvids()
    .then((bvids) => {
      for (const bvid of state.pendingSavedBvids) {
        bvids.add(bvid)
      }
      state.bvids = bvids
      return bvids
    })
    .catch((error) => {
      console.error('load watch later list failed', error)
      state.bvids = new Set(state.pendingSavedBvids)
      return state.bvids
    })

  return state
}

async function fetchWatchLaterBvids() {
  const resp = await fetch(WATCH_LATER_API_URL, {
    credentials: 'include',
  })
  const result: WatchLaterData = await resp.json()
  if (result.code !== 0) {
    throw new Error(result.message || '获取稍后再看列表失败')
  }

  return new Set((result.data.list || []).map(item => item.bvid).filter(Boolean))
}

function syncWatchLaterButtons(container: Cash, watchLaterState: WatchLaterState) {
  watchLaterState.promise
    .then((bvids) => {
      container.find('.watch-later-button').each((i, el) => {
        const button = el as HTMLButtonElement
        const bvid = button.dataset.bvid
        if (bvid && bvids.has(bvid)) {
          setWatchLaterButtonState(button, 'saved')
        }
      })
    })
    .catch((error) => {
      console.error('sync watch later buttons failed', error)
    })
}

function markBvidAsWatchLater(watchLaterState: WatchLaterState, bvid: string) {
  watchLaterState.pendingSavedBvids.add(bvid)
  watchLaterState.bvids?.add(bvid)
}

function unmarkBvidAsWatchLater(watchLaterState: WatchLaterState, bvid: string) {
  watchLaterState.pendingSavedBvids.delete(bvid)
  watchLaterState.bvids?.delete(bvid)
}

function getBilibiliCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)bili_jct=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

async function addToWatchLater(bvid: string) {
  const csrf = getBilibiliCsrfToken()
  if (!csrf) {
    throw new Error('未找到登录凭据')
  }

  const body = new URLSearchParams({
    bvid,
    csrf,
  })
  const resp = await fetch(WATCH_LATER_ADD_API_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const result = await resp.json()
  if (result.code !== 0) {
    throw new Error(result.message || '保存失败')
  }
}

async function removeFromWatchLater(aid: string) {
  const csrf = getBilibiliCsrfToken()
  if (!csrf) {
    throw new Error('未找到登录凭据')
  }

  const body = new URLSearchParams({
    aid,
    csrf,
  })
  const resp = await fetch(WATCH_LATER_REMOVE_API_URL, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })
  const result = await resp.json()
  if (result.code !== 0) {
    throw new Error(result.message || '取消保存失败')
  }
}

function setWatchLaterButtonState(button: HTMLButtonElement, state: 'idle'|'saving'|'saved'|'removing'|'error', message?: string) {
  const currentState = button.dataset.watchLaterState
  const label = button.querySelector('span:last-child')
  button.classList.remove('is-saving', 'is-saved', 'is-error')
  button.disabled = state === 'saving' || state === 'removing'

  if (state === 'idle' || state === 'saved') {
    button.dataset.watchLaterState = state
  }

  if (state === 'saving') {
    button.classList.add('is-saving')
    if (label) label.textContent = '保存中'
    button.title = '正在更新稍后再看状态'
  } else if (state === 'removing') {
    button.classList.add('is-saving')
    if (label) label.textContent = '取消中'
    button.title = '正在取消稍后再看'
  } else if (state === 'saved') {
    button.classList.add('is-saved')
    if (label) label.textContent = '已保存'
    button.title = '已保存到稍后再看，点击取消'
  } else if (state === 'error') {
    button.classList.add('is-error')
    if (label) label.textContent = '重试'
    button.title = message || '保存失败，点击重试'
    button.disabled = false
    if (currentState === 'saved') {
      button.dataset.watchLaterState = 'saved'
    } else {
      button.dataset.watchLaterState = 'idle'
    }
  } else {
    if (label) label.textContent = '稍后再看'
    button.title = '保存到稍后再看'
  }
}

const scrollBottomOffset = 5;

function detectScrollToBottom(callback: () => Promise<void>) {
  let isDoing = false;

  window.addEventListener("scroll", async function () {
    if (isDoing) return

    const scrollPosition = window.scrollY;
    const windowSize = window.innerHeight;
    const fullSize = document.body.scrollHeight;
    // console.log('scroll', isDoing, scrollPosition, scrollPosition + windowSize, fullSize)
    if (scrollPosition + windowSize + scrollBottomOffset > fullSize) {
      isDoing = true
      await callback();
      isDoing = false
    }
  });
}

function observeRecommend(blockedWords: string[]) {

  const targetNode = document.querySelector('.recommended-container_floor-aside .container') as HTMLDivElement

  const debouncedCleanRecommend = runOnceInTime(() => cleanRecommendItems(targetNode, blockedWords), 2000)
  cleanRecommendItems(targetNode, blockedWords)

  // Callback function to execute when mutations are observed
  const callback: MutationCallback = (mutationsList: MutationRecord[], observer: MutationObserver) => {
    for (const mutation of mutationsList) {
      if (mutation.type === 'childList') {
        // do something because child elements have changed
        // console.log('A child node has been added or removed.')
        debouncedCleanRecommend()
      }
    }
  };

  // Create an observer instance linked to the callback function
  const observer = new MutationObserver(callback);

  // Options for the observer (which mutations to observe)
  const config: MutationObserverInit = { childList: true };

  // Start observing the target node for configured mutations
  observer.observe(targetNode, config);
}

function runOnceInTime(fn: () => void, interval: number): () => void {
  let timerId: NodeJS.Timeout | null = null;

  return () => {
    if (timerId === null) {
      setTimeout(fn, 200);
      timerId = setTimeout(() => {
        timerId = null;
      }, interval);
    }
  };
}

function removeAdsAndBlockedWordsIn(el: HTMLElement, blockedWords: string[]) {
  lg.info('removeAdsAndBlockedWordsIn', el)
  const $el = $(el)

  // remove ads
  $el.find('.bili-video-card__info--ad, .bili-video-card__info--creative-ad').each((i, el) => {
    removeVideoCardParent(el)
  })
  $el.find('.bili-live-card').remove()

  // remove blocked words
  if (blockedWords.length > 0) {
    $el.find('.bili-video-card__info--tit').each((i, el) => {
      // console.log('info el content', el.textContent);
      const title = el.textContent
      for (const word of blockedWords) {
        if (title && title.toLowerCase().includes(word.toLowerCase())) {
          console.log('remove recommend video:', title)
          removeVideoCardParent(el)
        }
      }
    })
  }
}

function cleanRecommendItems(el: HTMLElement, blockedWords: string[]) {
  removeAdsAndBlockedWordsIn(el, blockedWords)
  limitRecommendItems(el, MAX_RECOMMEND_ITEMS)
}

function limitRecommendItems(el: HTMLElement, limit: number) {
  $(el).children().each((i, child) => {
    if (i >= limit) {
      child.remove()
    }
  })
}

function removeVideoCardParent(el: HTMLElement) {
  const videoCard = $(el).closest('.bili-video-card')
  const parent = videoCard.parent()
  if (parent.hasClass('feed-card')) {
    parent.remove()
  } else {
    videoCard.remove()
  }
}
