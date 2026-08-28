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

function stateFilePath(xdgStateHome, home) {
  var base = String(xdgStateHome || "")
  if (!base) base = String(home || "") + "/.local/state"
  return base + "/omakei/state.json"
}

/**
 * Read the ledger's location out of the server's state file, so attaching a
 * folder in the editor is all anyone has to do.
 */
function ledgerPathFromState(raw) {
  try {
    var data = JSON.parse(String(raw || ""))
    if (!data || data.version !== 1) return ""
    if (typeof data.ledgerPath === "string" && data.ledgerPath) return data.ledgerPath
    if (typeof data.statementsDir === "string" && data.statementsDir) {
      return String(data.statementsDir).replace(/\/$/, "") + "/omakei-ledger.json"
    }
    return ""
  } catch (e) {
    return ""
  }
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
function parseReaderOutput(raw) {
  try {
    var payload = JSON.parse(String(raw || ""))
    if (!payload || typeof payload !== "object") return { path: "", ledger: null }
    return {
      path: typeof payload.path === "string" ? payload.path : "",
      ledger: normalizeLedger(payload.ledger)
    }
  } catch (e) {
    return { path: "", ledger: null }
  }
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
    if (!tx || String(tx.date).slice(0, 7) !== key) continue
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
