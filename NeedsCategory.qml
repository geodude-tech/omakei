import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

/**
 * The popup's "Needs a category" section: the merchants Omakei could not
 * place, each with a dropdown that gives it one.
 *
 * This is the one thing in the widget only the person can answer -- what is
 * `SQ *PORCH SUPPLY`? -- and the only thing the widget writes. It writes it the
 * way every Omarchy panel does: by running a CLI that already works from a
 * terminal. `omakei-categorize.mjs <merchant> <category>` writes the rule,
 * re-derives every transaction with the shipped engine, and bumps the revision
 * file, so the row leaves on the read that follows.
 *
 * It lives in its own file because the queue, the failure state, and the
 * dropdown bookkeeping are a self-contained machine that has nothing to do with
 * the month the panel is showing. `Panel.qml` hands it rows and listens for
 * `wrote()`.
 */
Column {
  id: root

  /** Rows from the reader: { merchant, count, total }, biggest first. */
  property var merchants: []
  /** How many there are in total, which may be more than were handed over. */
  property int total: 0
  /** Where the plugin was cloned to, so the CLI can be found. */
  property string pluginDir: ""

  property color foreground: Color.foreground
  property color dim: Qt.darker(foreground, 1.45)
  property color urgent: Color.urgent
  property string fontFamily: Style.font.family

  /**
   * True while a dropdown owns the keyboard. The panel suspends its own key
   * catcher on this, or `j`/`k` would walk the options and step the month at
   * once, and Escape would close the whole popup instead of the dropdown.
   */
  readonly property bool dropdownOpen: openDropdowns > 0

  /** A rule was written, or refused. Either way the ledger is worth re-reading. */
  signal wrote()

  visible: merchants.length > 0
  spacing: Style.space(6)

  /**
   * The categories a merchant can be given, plus the placeholder an untouched
   * dropdown shows. Built once: the taxonomy is fixed.
   */
  readonly property var categoryOptions: Model.categoryOptions("Categorize…")

  /**
   * Rules asked for and not yet written; `writingMerchant` is the one in
   * flight. They go one at a time because the CLI refuses a write against a
   * ledger that moved under it -- two racing invocations would make one re-read
   * and retry for nothing.
   */
  property var pendingWrites: []
  property string writingMerchant: ""

  /**
   * Merchants whose rule the CLI refused to write -- no ledger, or three lost
   * races against something writing continuously. The row says so instead of
   * reverting as though the choice was never made. A write that silently does
   * nothing is the failure this ledger has already been bitten by once.
   */
  property var failedMerchants: []

  /**
   * How many dropdowns have their popup open. Never let it go negative: a row
   * whose popup is open can be destroyed under it -- the re-read after a write
   * rebuilds the list -- and both the destruction and the closing popup want to
   * decrement. One count too many would leave the panel's keys unblocked with a
   * dropdown open, which is the bug this exists to prevent.
   */
  property int openDropdowns: 0

  function hasFailed(merchant) {
    return root.failedMerchants.indexOf(merchant) >= 0
  }

  function setFailed(merchant, failed) {
    var next = root.failedMerchants.filter(function(m) { return m !== merchant })
    if (failed) next.push(merchant)
    root.failedMerchants = next
  }

  function setDropdownOpen(open) {
    root.openDropdowns = Math.max(0, root.openDropdowns + (open ? 1 : -1))
  }

  function isPending(merchant) {
    if (root.writingMerchant === merchant) return true
    for (var i = 0; i < root.pendingWrites.length; i++) {
      if (root.pendingWrites[i].merchant === merchant) return true
    }
    return false
  }

  function categorize(merchant, categoryId) {
    var command = Model.categorizeCommand(root.pluginDir, merchant, categoryId)
    // An empty command means a merchant, a category, or a plugin directory we
    // do not have. Do nothing rather than run something half-formed.
    if (command.length === 0) return
    // A second pick for the same merchant is queued, not dropped. The rule is
    // keyed by pattern, so the last write wins -- which is the category the
    // dropdown is showing. Dropping it would leave the popup claiming one
    // category and the ledger holding another.
    var queue = root.pendingWrites.slice()
    queue.push({ merchant: merchant, command: command })
    root.pendingWrites = queue
    root.setFailed(merchant, false)
    root.startNextWrite()
  }

  function startNextWrite() {
    if (categorizer.running || root.pendingWrites.length === 0) return
    var queue = root.pendingWrites.slice()
    var next = queue.shift()
    root.pendingWrites = queue
    root.writingMerchant = next.merchant
    categorizer.command = next.command
    categorizer.running = true
  }

  Process {
    id: categorizer
    running: false
    onExited: function(exitCode, exitStatus) {
      // The CLI says what went wrong on stderr, which nobody is reading here.
      // The row carries the fact that it failed; the reason is one `--list`
      // away in a terminal.
      root.setFailed(root.writingMerchant, exitCode !== 0)
      root.writingMerchant = ""
      root.wrote()
      root.startNextWrite()
    }
  }

  Text {
    text: "NEEDS A CATEGORY"
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  Repeater {
    model: root.merchants

    Row {
      id: merchantRow
      required property var modelData
      width: root.width
      spacing: Style.space(10)
      // Dimmed while its rule is being written. The row does not vanish here --
      // it goes when the re-read says it is gone.
      opacity: root.isPending(merchantRow.modelData.merchant) ? 0.5 : 1

      Column {
        anchors.verticalCenter: parent.verticalCenter
        width: merchantRow.width - picker.width - merchantRow.spacing
        spacing: Style.space(2)

        Text {
          width: parent.width
          text: merchantRow.modelData.merchant
          color: root.foreground
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          elide: Text.ElideRight
        }
        Text {
          readonly property bool failed: root.hasFailed(merchantRow.modelData.merchant)
          width: parent.width
          text: failed
            ? "could not save — try it in a terminal"
            : merchantRow.modelData.count + " · "
              + Model.formatMoney(merchantRow.modelData.total, { sign: true })
          color: failed ? root.urgent : root.dim
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
        }
      }

      Dropdown {
        id: picker
        anchors.verticalCenter: parent.verticalCenter
        width: Style.space(150)
        showLabel: false
        foreground: root.foreground
        fontFamily: root.fontFamily
        options: root.categoryOptions
        value: ""
        onChanged: function(v) {
          // The placeholder is a real option in the list, so selecting it has
          // to mean nothing rather than write a rule with no category.
          if (v === "") return
          root.categorize(merchantRow.modelData.merchant, v)
        }
        onPopupOpenChanged: root.setDropdownOpen(picker.popupOpen)
        Component.onDestruction: {
          if (picker.popupOpen) root.setDropdownOpen(false)
        }
      }
    }
  }

  Text {
    width: root.width
    visible: root.total > root.merchants.length
    wrapMode: Text.WordWrap
    text: (root.total - root.merchants.length) + " more — omakei-categorize.mjs --list"
    color: root.dim
    font.family: root.fontFamily
    font.pixelSize: Style.font.bodySmall
  }
}
