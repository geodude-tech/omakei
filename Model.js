var TRANSFER_CATEGORY = "transfers"

var CATEGORY_NAMES = {
  housing: "Housing",
  utilities: "Utilities",
  groceries: "Groceries",
  transport: "Transport",
  health: "Health",
  childcare: "Child care",
  dining: "Dining",
  coffee: "Coffee",
  shopping: "Shopping",
  "personal-care": "Personal care",
  entertainment: "Entertainment",
  subscriptions: "Subscriptions",
  travel: "Travel",
  income: "Income",
  transfers: "Transfers",
  fees: "Fees & interest",
  other: "Other"
}

var MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
]

/**
 * The file the server rewrites whenever the ledger changes.
 *
 * The widget watches this and nothing else. It never reads it -- the token
 * inside is meaningless -- it only needs to be told that something happened, at
 * which point it runs the reader. Watching the ledger itself is what used to
 * pull an unbounded file into the bar.
 */
function revisionFilePath(xdgStateHome, home) {
  var base = String(xdgStateHome || "")
  if (!base) base = String(home || "") + "/.local/state"
  return base + "/omakei/ledger-revision"
}

function expandPath(path, home) {
  var p = String(path || "").replace(/^\s+|\s+$/g, "")
  var root = String(home || "")
  if (p === "~") return root
  if (p.indexOf("~/") === 0) return root + p.slice(1)
  return p
}

function currentMonth(date) {
  var d = date || new Date()
  var month = d.getMonth() + 1
  return d.getFullYear() + "-" + (month < 10 ? "0" : "") + month
}

function shiftMonth(key, delta) {
  var parts = String(key || "").split("-")
  var year = Number(parts[0])
  var month = Number(parts[1])
  if (!year || !month) return currentMonth()
  var d = new Date(year, month - 1 + Number(delta || 0), 1)
  return currentMonth(d)
}

function monthOf(tx) {
  return String((tx && tx.date) || "").slice(0, 7)
}

/** The newest "YYYY-MM" any transaction falls in, or "" for none. */
function latestMonth(transactions) {
  var rows = Array.isArray(transactions) ? transactions : []
  var latest = ""
  for (var i = 0; i < rows.length; i++) {
    var key = monthOf(rows[i])
    if (key.length === 7 && key > latest) latest = key
  }
  return latest
}

function monthHasTransactions(transactions, key) {
  var rows = Array.isArray(transactions) ? transactions : []
  for (var i = 0; i < rows.length; i++) {
    if (monthOf(rows[i]) === key) return true
  }
  return false
}

/**
 * The month the popup opens on. It normally tracks the calendar, but a freshly
 * synced ledger often holds only closed statement periods -- last month's
 * export, dropped in on the 3rd -- and a strict current-month view would then
 * show nothing but zeros. So when this month is empty, fall back to the month
 * the editor last had open, then to the newest month with any activity.
 */
function openingMonth(ledger, today) {
  var now = currentMonth(today)
  var transactions = ledger && ledger.transactions
  if (!Array.isArray(transactions) || transactions.length === 0) return now
  if (monthHasTransactions(transactions, now)) return now
  var selected = ledger && ledger.selectedMonth
  if (selected && monthHasTransactions(transactions, selected)) return selected
  return latestMonth(transactions) || now
}

function formatMonthLabel(key) {
  var parts = String(key || "").split("-")
  var year = Number(parts[0])
  var month = Number(parts[1])
  if (!year || !month || month < 1 || month > 12) return String(key || "")
  return MONTH_NAMES[month - 1] + " " + year
}

function formatDay(iso) {
  var parts = String(iso || "").split("-")
  var month = Number(parts[1])
  var day = Number(parts[2])
  if (!month || !day || month < 1 || month > 12) return String(iso || "")
  return MONTH_NAMES[month - 1].slice(0, 3) + " " + day
}

function formatMoney(n, opts) {
  opts = opts || {}
  var value = Number(n)
  if (isNaN(value)) value = 0
  var sign = 0
  if (value < -0.005) sign = -1
  else if (value > 0.005) sign = 1
  var abs = Math.abs(value)
  var body
  if (opts.compact && abs >= 1000) {
    var k = abs / 1000
    var digits = k >= 10 ? String(Math.round(k)) : k.toFixed(1).replace(/\.0$/, "")
    body = "$" + digits + "k"
  } else {
    body = "$" + withCommas(Math.round(abs))
  }
  if (opts.sign) {
    if (sign < 0) return "−" + body
    if (sign > 0) return "+" + body
    return body
  }
  if (sign < 0 && !opts.abs) return "−" + body
  return body
}

function withCommas(n) {
  var s = String(n)
  var out = ""
  var count = 0
  for (var i = s.length - 1; i >= 0; i--) {
    out = s.charAt(i) + out
    count++
    if (count === 3 && i > 0) {
      out = "," + out
      count = 0
    }
  }
  return out
}

function isTransfer(tx) {
  return !!(tx && tx.categoryId === TRANSFER_CATEGORY)
}

function isSpend(tx) {
  return !!(tx && tx.amount < 0 && !isTransfer(tx))
}

function isIncome(tx) {
  return !!(tx && tx.amount > 0 && !isTransfer(tx))
}

function parseSetAsides(raw) {
  if (!Array.isArray(raw)) return []
  var out = []
  for (var i = 0; i < raw.length; i++) {
    var item = raw[i]
    if (!item || typeof item.id !== "string" || item.id.length === 0) continue
    var amount = Number(item.amount)
    if (!isFinite(amount) || amount < 0) amount = 0
    out.push({
      id: item.id,
      name: typeof item.name === "string" ? item.name : "",
      amount: Math.round(amount * 100) / 100
    })
  }
  return out
}

function setAsideTotal(setAsides) {
  var total = 0
  if (!Array.isArray(setAsides)) return 0
  for (var i = 0; i < setAsides.length; i++) total += Number(setAsides[i].amount) || 0
  return Math.round(total * 100) / 100
}

function normalizeLedger(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.transactions)) return null
  var transactions = []
  for (var i = 0; i < data.transactions.length; i++) {
    var tx = data.transactions[i]
    if (!tx || typeof tx.date !== "string" || typeof tx.amount !== "number") continue
    transactions.push(tx)
  }
  return {
    selectedMonth: typeof data.selectedMonth === "string" ? data.selectedMonth : "",
    transactions: transactions,
    setAsides: parseSetAsides(data.setAsides)
  }
}

function parseLedger(raw) {
  try {
    return normalizeLedger(JSON.parse(String(raw || "")))
  } catch (e) {
    return null
  }
}

/**
 * Read what `scripts/omakei-read-ledger.mjs` prints: the resolved path and the
 * ledger found there, either of which may be empty. The panel shows the path in
 * its empty state, so it is wanted even when the ledger is null.
 *
 * The reader is trusted to emit JSON and nothing else, but a crashed or
 * half-written pipe still has to land somewhere sane rather than throwing
 * inside a signal handler.
 */
function emptyReaderOutput() {
  return { path: "", ledger: null, uncategorized: { merchants: [], total: 0 } }
}

function parseReaderOutput(raw) {
  try {
    var payload = JSON.parse(String(raw || ""))
    if (!payload || typeof payload !== "object") return emptyReaderOutput()
    return {
      path: typeof payload.path === "string" ? payload.path : "",
      ledger: normalizeLedger(payload.ledger),
      uncategorized: parseUncategorized(payload.uncategorized)
    }
  } catch (e) {
    return emptyReaderOutput()
  }
}

/**
 * The "Needs a category" rows the reader computed, defended the same way the
 * ledger is: a half-written pipe must land somewhere sane, not throw inside a
 * signal handler.
 *
 * The merchant keys come from the reader's `extractMerchant`, never from here.
 * A second implementation of that heuristic in QML would name a merchant the
 * CLI does not recognize, and the rule the popup wrote would match nothing.
 */
function parseUncategorized(data) {
  var empty = { merchants: [], total: 0 }
  if (!data || typeof data !== "object") return empty
  var rows = Array.isArray(data.merchants) ? data.merchants : []
  var merchants = []
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (!row || typeof row.merchant !== "string" || !row.merchant) continue
    merchants.push({
      merchant: row.merchant,
      count: Number(row.count) || 0,
      total: Number(row.total) || 0
    })
  }
  var total = Number(data.total)
  return {
    merchants: merchants,
    total: isFinite(total) && total > merchants.length ? Math.floor(total) : merchants.length
  }
}

/**
 * The categories a merchant can be assigned to, in the order the app lists
 * them. `Dropdown` takes exactly this shape. A placeholder is prepended when
 * one is given, because a dropdown that has never been touched has no value to
 * show; selecting it is a no-op the caller drops.
 */
function categoryOptions(placeholder) {
  var options = []
  if (placeholder) options.push({ value: "", label: String(placeholder) })
  for (var id in CATEGORY_NAMES) {
    if (!Object.prototype.hasOwnProperty.call(CATEGORY_NAMES, id)) continue
    options.push({ value: id, label: CATEGORY_NAMES[id] })
  }
  return options
}

/**
 * The one write the widget can make: a rule for this merchant, in this
 * category, through the CLI that already does it from a terminal. Returned as
 * an argv array, so nothing here has to be quoted and no shell is involved.
 *
 * Anything missing or unknown returns [] rather than a command with a hole in
 * it. The CLI validates the category too -- this is the near check, not the
 * only one.
 */
function categorizeCommand(pluginDir, merchant, categoryId) {
  var dir = String(pluginDir || "").replace(/\/$/, "")
  var name = String(merchant || "").replace(/^\s+|\s+$/g, "")
  var id = String(categoryId || "")
  if (!dir || !name) return []
  if (!Object.prototype.hasOwnProperty.call(CATEGORY_NAMES, id)) return []
  return [dir + "/scripts/omakei-categorize.mjs", name, id]
}

function emptySummary(month) {
  var key = month || currentMonth()
  return {
    month: key,
    monthLabel: formatMonthLabel(key),
    spent: 0,
    income: 0,
    net: 0,
    uncategorized: 0,
    cats: [],
    recent: [],
    allocated: 0,
    setAsides: [],
    hasData: false
  }
}

function summarize(transactions, month, setAsides) {
  var key = month || currentMonth()
  var rows = Array.isArray(transactions) ? transactions : []
  var spent = 0
  var income = 0
  var uncategorized = 0
  var catMap = {}
  var recent = []
  var reserved = parseSetAsides(setAsides)
  var allocated = setAsideTotal(reserved)

  for (var i = 0; i < rows.length; i++) {
    var tx = rows[i]
    if (!tx || monthOf(tx) !== key) continue
    if (isSpend(tx)) {
      var amount = Math.abs(tx.amount)
      spent += amount
      var catId = tx.categoryId || "other"
      catMap[catId] = (catMap[catId] || 0) + amount
    }
    if (isIncome(tx)) income += tx.amount
    if (!tx.categoryId) uncategorized++
    if (!isTransfer(tx)) recent.push(tx)
  }

  recent.sort(function (a, b) {
    if (a.date === b.date) return Math.abs(b.amount) - Math.abs(a.amount)
    return a.date < b.date ? 1 : -1
  })

  var cats = []
  for (var id in catMap) {
    if (!Object.prototype.hasOwnProperty.call(catMap, id)) continue
    if (id === TRANSFER_CATEGORY) continue
    cats.push({
      id: id,
      name: CATEGORY_NAMES[id] || "Other",
      total: catMap[id]
    })
  }
  cats.sort(function (a, b) { return b.total - a.total })

  var clipped = []
  var limit = Math.min(8, recent.length)
  for (var r = 0; r < limit; r++) {
    var row = recent[r]
    clipped.push({
      date: row.date,
      day: formatDay(row.date),
      description: String(row.description || "").replace(/\s+/g, " "),
      amount: row.amount,
      category: CATEGORY_NAMES[row.categoryId] || (row.categoryId ? row.categoryId : "Uncategorized")
    })
  }

  return {
    month: key,
    monthLabel: formatMonthLabel(key),
    spent: Math.round(spent * 100) / 100,
    income: Math.round(income * 100) / 100,
    net: Math.round((income - spent - allocated) * 100) / 100,
    uncategorized: uncategorized,
    cats: cats.slice(0, 8),
    recent: clipped,
    allocated: allocated,
    setAsides: reserved,
    hasData: rows.length > 0
  }
}

function barLabel(summary) {
  if (!summary || !summary.hasData) return "Omakei"
  return formatMoney(summary.net, { sign: true, compact: true })
}

function editorQuery(summary) {
  if (!summary || !summary.month) return ""
  return "m=" + encodeURIComponent(summary.month)
}

function editorUrl(base, summary) {
  var url = String(base || "").replace(/^\s+|\s+$/g, "")
  if (!url) return ""
  var query = editorQuery(summary)
  if (!query) return url
  var hash = ""
  var hashAt = url.indexOf("#")
  if (hashAt >= 0) {
    hash = url.slice(hashAt)
    url = url.slice(0, hashAt)
  }
  var sep = url.indexOf("?") >= 0 ? "&" : "?"
  return url + sep + query + hash
}

function shellQuote(value) {
  return "'" + String(value || "").replace(/'/g, "'\\''") + "'"
}

/**
 * Always route through the plugin's own opener: it starts the editor when
 * nothing is serving yet, which `omarchy launch browser` cannot do. Callers
 * without a plugin directory get "" rather than a command that opens a dead
 * page.
 */
function openEditorCommand(base, summary, pluginDir) {
  var url = editorUrl(base, summary)
  var dir = String(pluginDir || "").replace(/\/$/, "")
  if (!url || !dir) return ""
  return shellQuote(dir + "/scripts/omakei-open") + " " + shellQuote(url)
}

/** Days in "YYYY-MM". Day 0 of the next month is the last day of this one. */
function daysInMonth(key) {
  var parts = String(key || "").split("-")
  var year = parseInt(parts[0], 10)
  var month = parseInt(parts[1], 10)
  if (!isFinite(year) || !isFinite(month)) return 30
  return new Date(year, month, 0).getDate()
}

/**
 * Spend per day for one month, plus the running total.
 *
 * The sparkline draws `cumulative`, not `spend`: a month's daily amounts are
 * spiky enough that the line reads as noise, while the running total reads as
 * a pace -- how fast this month is being spent, and whether it flattened.
 * Both are returned so a future view can draw either without a second pass.
 *
 * Days are always 1..daysInMonth, including days with nothing, so the x axis
 * is the month rather than the days that happened to have activity.
 */
function dailySpend(transactions, month) {
  var key = month || currentMonth()
  var count = daysInMonth(key)
  var rows = Array.isArray(transactions) ? transactions : []
  var perDay = []
  var i
  for (i = 0; i < count; i++) perDay.push(0)

  for (i = 0; i < rows.length; i++) {
    var tx = rows[i]
    if (!tx || monthOf(tx) !== key || !isSpend(tx)) continue
    var day = parseInt(String(tx.date).slice(8, 10), 10)
    if (!isFinite(day) || day < 1 || day > count) continue
    perDay[day - 1] += Math.abs(tx.amount)
  }

  var days = []
  var running = 0
  var maxDaily = 0
  for (i = 0; i < count; i++) {
    running += perDay[i]
    if (perDay[i] > maxDaily) maxDaily = perDay[i]
    days.push({ day: i + 1, spend: perDay[i], cumulative: running })
  }

  return {
    days: days,
    daysInMonth: count,
    maxDaily: Math.round(maxDaily * 100) / 100,
    total: Math.round(running * 100) / 100
  }
}
