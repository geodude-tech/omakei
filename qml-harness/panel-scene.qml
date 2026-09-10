import QtQuick
import Quickshell

/**
 * `Panel.qml` instantiated for real, and never shown.
 *
 * The offscreen scene next door can only compile the panel: `KeyboardPanel` is
 * a `PanelWindow`, and with no Wayland backend it fails to load before a single
 * binding runs. So every property the panel exposes -- and every property the
 * bar widget reads back off it by name -- went unevaluated, where a rename is a
 * silent runtime error rather than a load failure.
 *
 * This creates the panel against a real compositor, which evaluates all of it,
 * and reads the values back. It must NEVER call `open()`. A mapped panel takes
 * the keyboard grab, and this runs on someone's desktop while they are working;
 * `Panel.close()` carries its own warning about what a panel stuck open costs.
 * Creating it maps nothing.
 *
 * `repo` is rewritten by `scripts/check-qml.mjs` before quickshell starts.
 */
ShellRoot {
  id: harness

  property string repo: "@REPO@"
  property var panel: null
  property int failures: 0
  property int step: 0

  /** The ledger staged on disk, so the arithmetic below is hand-checkable. */
  readonly property string fixedToday: "2026-09-09"
  readonly property string fixedMonth: "2026-09"

  function check(label, ok) {
    console.log((ok ? "PASS  " : "FAIL  ") + label)
    if (!ok) harness.failures += 1
  }

  function near(a, b) {
    return Math.abs(a - b) < 0.005
  }

  function done(code) {
    console.log("PANEL HARNESS DONE failures=" + harness.failures)
    Qt.exit(code)
  }

  /** Whatever happens, this process dies rather than lingering on a desktop. */
  Timer {
    interval: 20000
    running: true
    onTriggered: {
      console.log("FAIL  the panel harness finished in time")
      harness.failures += 1
      harness.done(1)
    }
  }

  Component.onCompleted: {
    var component = Qt.createComponent(harness.repo + "/Panel.qml", Component.PreferSynchronous)
    if (component.status !== Component.Ready) {
      harness.check("Panel.qml loads against a real backend", false)
      console.log("  " + component.errorString())
      harness.done(1)
      return
    }
    harness.panel = component.createObject(null)
    harness.check("Panel.qml loads against a real backend", harness.panel !== null)
    if (!harness.panel) {
      harness.done(1)
      return
    }
    // The panel reads its own directory to find the reader script. Loading it
    // from the repo rather than the staging directory is what makes that work.
    harness.check("the panel found its plugin directory",
      harness.panel.pluginDir === harness.repo)
    driver.running = true
  }

  Timer {
    id: driver
    interval: 400
    repeat: true
    onTriggered: harness.advance()
  }

  function advance() {
    harness.step += 1
    var p = harness.panel

    if (harness.step === 1) {
      // The reader runs on load. Nothing below means anything until it lands.
      harness.check("the reader filled the ledger", !!p.ledger)
      harness.check("the reader reported where the ledger is", p.ledgerPath !== "")
      if (!p.ledger) {
        harness.done(1)
        return
      }
      // Pin the clock so the window is the same every run.
      p.today = new Date(2026, 8, 9)
      p.viewMonth = harness.fixedMonth
    } else if (harness.step === 2) {
      // Staged ledger: 4000 in on Aug 5 (before the window opens), 4000 on
      // Aug 20 and 4000 on Aug 28, then 2600 + 1800 + 100 out in September.
      // 500 is set aside. Window is Aug 10 - Sep 9.
      var r = p.rollingSummary
      harness.check("the window ends today", r.end === harness.fixedToday)
      harness.check("the window opens a month back", r.start === "2026-08-10")
      harness.check("the window is labelled by its dates", r.label === "Aug 10 – Sep 9")
      harness.check("income before the window opens is left out", harness.near(r.income, 8000))
      harness.check("spend inside the window is counted", harness.near(r.spent, 4500))
      harness.check("the set-aside comes off the window", harness.near(r.net, 3000))
      harness.check("a ledger reaching back is complete", r.complete === true)

      harness.check("the headline rolls on the current month", p.rollingHeadline === true)
      harness.check("the headline is the window's net", harness.near(p.headlineNet, 3000))
      harness.check("spent under the headline is the window's",
        harness.near(p.headlineSpent, 4500))
      harness.check("in under the headline is the window's",
        harness.near(p.headlineIncome, 8000))
      // The month it replaces, for contrast: no pay has landed by the 9th.
      harness.check("the month-to-date figure is still the month's",
        harness.near(p.monthSummary.net, -5000))

      // The bar reads these two names off the panel. A rename here is exactly
      // the silent runtime error this whole scene exists to catch.
      harness.check("the bar summary is the rolling one",
        p.barSummary === p.rollingSummary)
      harness.check("the bar summary carries what the tooltip needs",
        typeof p.barSummary.spent === "number" && typeof p.barSummary.income === "number"
          && typeof p.barSummary.allocated === "number" && p.barSummary.hasData === true)

      p.viewMonth = "2026-08"
    } else if (harness.step === 3) {
      harness.check("a past month stops the headline rolling", p.rollingHeadline === false)
      harness.check("a past month is shown as itself",
        harness.near(p.headlineNet, p.monthSummary.net))
      harness.check("the bar still speaks for now on a past month",
        p.barSummary === p.rollingSummary)

      // A ledger that starts inside the window: everything falls back.
      p.viewMonth = harness.fixedMonth
      p.ledger = {
        transactions: [
          { date: "2026-09-01", description: "MORTGAGE", amount: -2600, categoryId: "housing" }
        ],
        setAsides: [],
        selectedMonth: harness.fixedMonth
      }
    } else if (harness.step === 4) {
      harness.check("a ledger stopping inside the window is incomplete",
        p.rollingSummary.complete === false)
      harness.check("an incomplete window does not roll", p.rollingHeadline === false)
      harness.check("the bar falls back to the month",
        p.barSummary === p.currentSummary)
      driver.running = false
      harness.done(harness.failures > 0 ? 1 : 0)
    }
  }
}
