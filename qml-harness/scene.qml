import QtQuick
import Quickshell
import Quickshell.Io

/**
 * The QML the widget has, exercised for real: the section renders, a dropdown
 * owns the keyboard while it is open, a pick runs `omakei-categorize.mjs`, and
 * a refused write says so.
 *
 * Run by `scripts/check-qml.mjs`, which stages this beside the plugin's own
 * files, points HOME at a throwaway ledger, and reads the PASS / FAIL lines
 * back. Nothing here touches a real ledger.
 *
 * `repo` and `statements` are rewritten by the runner before quickshell starts.
 */
ShellRoot {
  id: harness

  property string repo: "@REPO@"
  property string statements: "@STATEMENTS@"
  property int step: 0
  property int failures: 0

  readonly property var rows: [
    { merchant: "PORCH SUPPLY", count: 1, total: -80 },
    { merchant: "ZORP WIDGETS", count: 2, total: -42.5 },
    { merchant: "QUUX BRAVO", count: 1, total: -5 },
    { merchant: "A VERY LONG MERCHANT NAME THAT KEEPS GOING AND GOING", count: 1, total: -3 }
  ]

  function check(label, ok) {
    console.log((ok ? "PASS  " : "FAIL  ") + label)
    if (!ok) harness.failures += 1
  }

  /** Every Dropdown under an item, found by duck-typing rather than by id. */
  function dropdownsIn(item, out) {
    out = out || []
    if (!item) return out
    var kids = item.children || []
    for (var i = 0; i < kids.length; i++) {
      if (kids[i] && "popupOpen" in kids[i] && "options" in kids[i]) out.push(kids[i])
      harness.dropdownsIn(kids[i], out)
    }
    return out
  }

  Process { id: chmodder }

  function chmodStatements(mode, done) {
    chmodder.command = ["chmod", mode, harness.statements]
    chmodder.exited.connect(function once() {
      chmodder.exited.disconnect(once)
      if (done) done()
    })
    chmodder.running = true
  }

  FloatingWindow {
    id: win
    implicitWidth: 460
    implicitHeight: 340
    visible: true

    Rectangle {
      anchors.fill: parent
      color: "#161616"

      NeedsCategory {
        id: section
        x: 14
        y: 14
        width: parent.width - 28
        pluginDir: harness.repo
        merchants: harness.rows
        total: 9
        foreground: "#e8e8e8"
      }
    }
  }

  Timer {
    id: driver
    interval: 400
    repeat: true
    running: true
    onTriggered: harness.advance()
  }

  function advance() {
    harness.step += 1
    var drops = harness.dropdownsIn(win.contentItem)

    if (harness.step === 1) {
      // A plugin is loaded from outside the shell's config root, where a
      // sibling .qml is not implicitly a type. Panel.qml carries a namespaced
      // directory import for that; this is the guard on it. The panel cannot
      // finish loading here (no PanelWindow backend offscreen), so the check is
      // that the failure is not a type-resolution one.
      var panel = Qt.createComponent(harness.repo + "/Panel.qml", Component.PreferSynchronous)
      var err = panel.status === Component.Error ? panel.errorString() : ""
      harness.check("Panel.qml resolves NeedsCategory as a type",
        err.indexOf("is not a type") < 0)
      if (err.indexOf("is not a type") >= 0) console.log("  " + err)

      harness.check("a row per merchant", drops.length === 4)
      harness.check("the placeholder plus the fixed 17 categories",
        drops.length > 0 && drops[0].options.length === 18)
    } else if (harness.step === 2) {
      drops[1].open()
    } else if (harness.step === 3) {
      harness.check("an open dropdown blocks the panel's keys", section.dropdownOpen === true)
      // Destroy the rows under the open popup, which is what the re-read after
      // a write does. The count must come back to zero, never below it.
      section.merchants = []
      Qt.callLater(function() { section.merchants = harness.rows })
    } else if (harness.step === 4) {
      harness.check("destroying an open row leaves the count at zero, not negative",
        section.openDropdowns === 0 && section.dropdownOpen === false)
      drops = harness.dropdownsIn(win.contentItem)
      drops[0].changed("groceries")
      drops[1].changed("shopping")
      harness.check("a second pick is queued, not dropped",
        section.writingMerchant !== "" && section.pendingWrites.length === 1)
    } else if (harness.step === 9) {
      harness.check("both writes finished",
        section.writingMerchant === "" && section.pendingWrites.length === 0)
      harness.check("neither write was refused", section.failedMerchants.length === 0)
    } else if (harness.step === 10) {
      driver.running = false
      harness.chmodStatements("a-w", function() { driver.running = true })
    } else if (harness.step === 11) {
      harness.dropdownsIn(win.contentItem)[2].changed("dining")
    } else if (harness.step === 15) {
      harness.check("a refused write is remembered against its merchant",
        section.hasFailed("QUUX BRAVO"))
      harness.check("the queue drained even though the write failed",
        section.writingMerchant === "" && section.pendingWrites.length === 0)
    } else if (harness.step === 16) {
      driver.running = false
      harness.chmodStatements("u+w", function() {
        console.log("HARNESS DONE failures=" + harness.failures)
        Qt.exit(harness.failures === 0 ? 0 : 1)
      })
    }
  }
}
