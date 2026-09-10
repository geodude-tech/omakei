import QtQuick
import QtQuick.Shapes
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model
/**
 * The plugin's own directory, namespaced. A plugin is loaded from
 * `~/.config/omarchy/plugins/<id>/` by absolute path, which is outside the
 * shell's config root, and there a sibling `.qml` is NOT implicitly a type --
 * `NeedsCategory { }` alone fails to compile with "NeedsCategory is not a
 * type", and a bare `import "."` does not fix it either. The namespace does.
 */
import "." as Local

Panel {
  id: root
  moduleName: "omakei"
  ipcTarget: "omakei"

  property var anchorItem: null
  property var hostWidget: null
  property bool openedFromHotkey: false

  readonly property var barIdentity: hostWidget || root
  readonly property color contentForeground: bar ? bar.foreground : Color.foreground
  readonly property color contentUrgent: bar ? bar.urgent : Color.urgent
  readonly property color contentDim: Qt.darker(contentForeground, 1.45)
  readonly property string contentFontFamily: bar ? bar.fontFamily : Style.font.family
  /**
   * The editor's server records the attached folder, so the ledger is found
   * without anyone typing a path. The widget setting still wins when it is
   * set, for a ledger kept somewhere the editor did not put it; it is handed to
   * the reader, which resolves and expands it.
   */
  readonly property string configuredLedgerPath: (settings && settings.ledgerPath)
    ? settings.ledgerPath
    : ""
  /** Where the reader found the ledger. Shown in the empty state. */
  property string ledgerPath: ""
  readonly property string appUrl: (settings && settings.appUrl) ? settings.appUrl : "http://127.0.0.1:8080/"

  property date today: new Date()
  property var ledger: null
  /**
   * The merchants with no category yet, as the reader grouped them, and how
   * many there are in total. Whole-ledger, not this month: a rule is
   * merchant-wide, so scoping the list to the month on screen would hide the
   * merchant whose rule the user is about to write.
   */
  property var uncategorized: ({ merchants: [], total: 0 })
  property string viewMonth: Model.currentMonth()
  property var monthSummary: Model.emptySummary(viewMonth)
  /**
   * While true, a synced ledger sets `viewMonth` for us -- normally this month,
   * but the newest month with activity when this month is empty. Stepping
   * through months with `‹` / `›` turns it off so a background sync cannot yank
   * the view; `t` ("this month") turns it back on.
   */
  property bool followLedgerMonth: true

  readonly property var currentSummary: {
    var now = Model.currentMonth(today)
    if (viewMonth === now) return monthSummary
    return Model.summarize(ledger && ledger.transactions, now, ledger && ledger.setAsides)
  }

  /**
   * In minus out over the month ending today, which is what the headline and
   * the bar show. See `Model.rollingSummary` for why it beats the month-to-date
   * figure: the mortgage and child care land on the 1st and the income that
   * covers them arrives later, so the calendar month opens deeply negative
   * every month regardless of how the finances are actually going.
   */
  readonly property var rollingSummary: Model.rollingSummary(
    ledger && ledger.transactions, ledger && ledger.setAsides, today)

  /**
   * A ledger that does not reach back a full month would report a month of
   * income against a week of spending, so it keeps the month figure until the
   * history is there.
   */
  readonly property bool rollingReady: !!(rollingSummary && rollingSummary.complete && rollingSummary.hasData)

  /** Past months are shown as themselves; only the current month rolls. */
  readonly property bool rollingHeadline: rollingReady && viewMonth === Model.currentMonth(today)

  /** The big number: the rolling window on this month, the month itself before. */
  readonly property real headlineNet: rollingHeadline ? rollingSummary.net : monthSummary.net

  /**
   * The spent/in pair reads off the same window as the headline, so the big
   * number decomposes into the two figures under it. Month-to-date would put
   * "$0 in" beneath a healthy headline for the first half of every month --
   * true of the month, and an invitation to read the headline as wrong.
   */
  readonly property real headlineSpent: rollingHeadline ? rollingSummary.spent : monthSummary.spent
  readonly property real headlineIncome: rollingHeadline ? rollingSummary.income : monthSummary.income

  /** The bar always speaks for now, whatever month the popup is browsing. */
  readonly property var barSummary: rollingReady ? rollingSummary : currentSummary

  readonly property real maxCategory: {
    if (!monthSummary.cats || monthSummary.cats.length === 0) return 1
    return Math.max(1, monthSummary.cats[0].total)
  }

  function open() {
    openedFromHotkey = false
    root.controller.show()
    setCenterHoverRevealSuppressed(false)
    if (!root.ledger) root.refresh()
  }

  function openFromHotkey() {
    openedFromHotkey = true
    if (!root.ledger) root.refresh()
    root.controller.show()
    Qt.callLater(function() {
      if (root.opened) setCenterHoverRevealSuppressed(true)
    })
  }

  /**
   * Hide first, then release the hover suppression. The order is the whole
   * point: suppression is cosmetic, hiding is not, and a panel that throws on
   * its way to `hide()` stays open holding the keyboard grab -- no Escape, no
   * bar click, no `ipc call omakei close`, nothing but a reboot.
   */
  function close() {
    root.controller.hide()
    setCenterHoverRevealSuppressed(false)
  }

  function toggle() {
    if (root.opened) root.close()
    else root.openFromHotkey()
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.barIdentity, direction)
    return false
  }

  /**
   * The bar handed to a plugin exposes this as a `readonly` mirror plus a
   * setter function; only the host's own Bar has the writable property. Assign
   * to it and QML throws, which is why the call is never the last thing a
   * lifecycle function does -- see `close()`.
   */
  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && typeof root.bar.setCenterHoverRevealSuppressed === "function")
      root.bar.setCenterHoverRevealSuppressed(value)
    else if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  function refresh() {
    root.today = new Date()
    // Re-running while a read is in flight would only race it.
    if (!ledgerReader.running) ledgerReader.running = true
  }

  function ingest(raw) {
    var out = Model.parseReaderOutput(raw)
    root.ledgerPath = out.path
    if (!out.ledger) {
      // Keep whatever was on screen: a failed read is not news that the
      // ledger is empty, and the bar should not blank out because of one.
      if (!root.ledger) root.applyLedger()
      return
    }
    root.ledger = out.ledger
    root.uncategorized = out.uncategorized
    if (root.followLedgerMonth) root.viewMonth = Model.openingMonth(root.ledger, root.today)
    root.applyLedger()
  }

  function applyLedger() {
    monthSummary = Model.summarize(ledger && ledger.transactions, viewMonth, ledger && ledger.setAsides)
  }

  function moveMonth(delta) {
    root.followLedgerMonth = false
    viewMonth = Model.shiftMonth(viewMonth, delta)
    applyLedger()
  }

  function goToCurrentMonth() {
    root.followLedgerMonth = true
    viewMonth = Model.currentMonth(today)
    applyLedger()
  }

  /** Directory this plugin was cloned into, so the opener can be found. */
  readonly property string pluginDir: {
    var dir = Qt.resolvedUrl(".").toString()
    if (dir.indexOf("file://") === 0) dir = dir.substring(7)
    return dir.replace(/\/$/, "")
  }

  function openOmakei() {
    var url = Model.editorUrl(root.appUrl, root.monthSummary)
    var cmd = Model.openEditorCommand(root.appUrl, root.monthSummary, root.pluginDir)
    if (!cmd) return
    if (root.bar) root.bar.run(cmd)
    else Quickshell.execDetached([root.pluginDir + "/scripts/omakei-open", url])
    root.close()
  }

  function netColor(value) {
    if (value < -0.005) return contentUrgent
    if (value > 0.005) return Color.accent
    return contentForeground
  }

  readonly property color reservedColor: Qt.tint(contentForeground, "#66c4a35a")

  /**
   * The ledger is read by `scripts/omakei-read-ledger.mjs`, not here.
   *
   * FileView cannot refuse a symlink, check that what it opened is a regular
   * file, or stop reading at a size, and it read synchronously while the bar
   * was starting -- so a large ledger, a FIFO, or a stalled mount hung the
   * whole bar at login. The reader does that work where the flags for it
   * exist, using the same bounded read the editor's server uses.
   *
   * This runs asynchronously, so the bar paints its empty state first and fills
   * in a moment later. That is the point: nothing here can block the shell.
   */
  Process {
    id: ledgerReader
    running: true
    command: [root.pluginDir + "/scripts/omakei-read-ledger.mjs", root.configuredLedgerPath]
    stdout: StdioCollector {
      onStreamFinished: root.ingest(this.text)
    }
  }

  // A changed setting points at a different ledger, so read it again.
  onConfiguredLedgerPathChanged: root.refresh()

  /**
   * The server rewrites this whenever the ledger changes; the bar re-reads when
   * it does, so saving in the editor still shows up here without anyone asking.
   *
   * `preload: false` and nothing ever calls `text()` or `reload()`, so this
   * file is watched but never read. That distinction is the whole point: a
   * watch costs nothing, while reading is what has to be bounded, and the
   * reader is where bounding happens.
   */
  FileView {
    id: ledgerRevision
    path: Model.revisionFilePath(Quickshell.env("XDG_STATE_HOME"), Quickshell.env("HOME"))
    preload: false
    watchChanges: true
    printErrors: false
    onFileChanged: root.refresh()
  }

  SystemClock {
    id: clock
    precision: SystemClock.Minutes
    /**
     * The day, not just the month. The headline window ends today, so a popup
     * left open overnight would otherwise keep reporting yesterday's month
     * until something else forced a refresh. Which month is on screen still
     * only moves when the month itself turns over.
     */
    onDateChanged: {
      if (Model.currentDay(clock.date) === Model.currentDay(root.today)) return
      var wasMonth = Model.currentMonth(root.today)
      var follow = root.followLedgerMonth || root.viewMonth === wasMonth
      root.today = clock.date
      if (follow && Model.currentMonth(clock.date) !== wasMonth) root.goToCurrentMonth()
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.barIdentity
    bar: root.bar
    open: root.opened
    centerOnBar: true
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(460))
    contentHeight: panel.fittedContentHeight(omakeiColumn.implicitHeight)

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // While a category dropdown is open it owns the keyboard: j/k walk its
      // options, Escape closes it. Without this the same keys would also drive
      // the month nav underneath and Escape would shut the whole popup.
      blocked: needsCategory.dropdownOpen
      onMoveRequested: function(dx, dy) {
        if (dx !== 0) root.moveMonth(dx)
      }
      onActivateRequested: root.openOmakei()
      onReturnRequested: root.openOmakei()
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      onTextKey: function(t) {
        if (t === "[" ) root.moveMonth(-1)
        else if (t === "]") root.moveMonth(1)
        else if (t === "t" || t === "T") root.goToCurrentMonth()
        else if (t === "o" || t === "O") root.openOmakei()
      }

      Flickable {
        id: omakeiScroll
        anchors.fill: parent
        contentWidth: width
        contentHeight: omakeiColumn.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        Column {
          id: omakeiColumn
          width: omakeiScroll.width
          spacing: Style.space(12)

          Item {
            width: parent.width
            height: monthRow.height

            Row {
              id: monthRow
              anchors.horizontalCenter: parent.horizontalCenter
              spacing: Style.space(12)

              Text {
                text: "‹"
                color: prevMouse.containsMouse ? Color.accent : root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.title
                MouseArea {
                  id: prevMouse
                  anchors.fill: parent
                  anchors.margins: -6
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.moveMonth(-1)
                }
              }

              Text {
                text: root.monthSummary.monthLabel
                color: root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.title
              }

              Text {
                text: "›"
                color: nextMouse.containsMouse ? Color.accent : root.contentForeground
                font.family: root.contentFontFamily
                font.pixelSize: Style.font.title
                MouseArea {
                  id: nextMouse
                  anchors.fill: parent
                  anchors.margins: -6
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: root.moveMonth(1)
                }
              }
            }
          }

          Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            text: Model.formatMoney(root.headlineNet, { sign: true })
            color: root.netColor(root.headlineNet)
            font.family: root.contentFontFamily
            font.pixelSize: 42
            font.bold: true
          }

          /**
           * The headline is a window, not the month above it, so it says which
           * one -- and keeps the month-to-date figure in view underneath, since
           * that is the number the month header would otherwise promise.
           */
          Text {
            width: parent.width
            visible: root.rollingHeadline
            horizontalAlignment: Text.AlignHCenter
            text: root.rollingSummary.label
            color: root.contentDim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
          }

          Text {
            width: parent.width
            visible: root.rollingHeadline
            horizontalAlignment: Text.AlignHCenter
            text: root.monthSummary.monthLabel + " so far  "
              + Model.formatMoney(root.monthSummary.net, { sign: true })
            color: root.contentDim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
          }

          /**
           * The month's spending as a pace line: cumulative spend, day 1 to the
           * last day of the month. Flat stretches are days nothing went out; a
           * steep run is a week that got away. `Model.dailySpend` does the
           * arithmetic, this only maps it onto the box.
           */
          Item {
            id: spark
            width: parent.width
            height: Style.space(60)
            visible: root.monthSummary.hasData

            readonly property var series: Model.dailySpend(
              root.ledger && root.ledger.transactions, root.viewMonth)
            /** Never divide by zero, and never let one cent fill the box. */
            readonly property real peak: Math.max(1, spark.series.total)
            readonly property real lastY: {
              var days = spark.series.days
              if (!days || days.length === 0) return spark.height
              return spark.plot(days[days.length - 1].cumulative)
            }

            /** Headroom, so the last point is a dot on the line and not on the rim. */
            readonly property real topInset: Style.space(5)
            readonly property real dotSize: Style.space(7)
            /** The line stops where the dot's centre goes, so the two agree. */
            readonly property real rightInset: spark.dotSize / 2

            function plot(value) {
              var usable = spark.height - spark.topInset
              return spark.height - (value / spark.peak) * usable
            }

            /**
             * The line starts at zero on the baseline, before day 1, so a big
             * first-of-the-month debit reads as the climb it is. Without that
             * origin the curve begins wherever rent left it and the whole month
             * looks flat.
             *
             * `closed` walks back along the baseline so the area can be filled.
             */
            function points(closed) {
              var days = spark.series.days
              var out = []
              if (!days || days.length < 2 || spark.width <= 0) return out
              var steps = days.length
              var span = spark.width - spark.rightInset
              out.push(Qt.point(0, spark.height))
              for (var i = 0; i < steps; i++) {
                out.push(Qt.point(span * ((i + 1) / steps),
                                  spark.plot(days[i].cumulative)))
              }
              if (closed) {
                out.push(Qt.point(span, spark.height))
                out.push(Qt.point(0, spark.height))
              }
              return out
            }

            Rectangle {
              anchors.left: parent.left
              anchors.right: parent.right
              anchors.bottom: parent.bottom
              height: 1
              color: Style.selectedFillFor(root.contentForeground, Color.accent)
            }

            Shape {
              anchors.fill: parent
              preferredRendererType: Shape.CurveRenderer

              ShapePath {
                strokeWidth: 0
                strokeColor: "transparent"
                fillGradient: LinearGradient {
                  x1: 0; y1: 0
                  x2: 0; y2: spark.height
                  GradientStop {
                    position: 0.0
                    color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.38)
                  }
                  GradientStop {
                    position: 1.0
                    color: Qt.rgba(Color.accent.r, Color.accent.g, Color.accent.b, 0.0)
                  }
                }
                PathPolyline { path: spark.points(true) }
              }

              ShapePath {
                strokeColor: Color.accent
                strokeWidth: 2
                capStyle: ShapePath.RoundCap
                joinStyle: ShapePath.RoundJoin
                fillColor: "transparent"
                PathPolyline { path: spark.points(false) }
              }
            }

            // Where the month has got to. Inset by its own width so the dot
            // sits fully inside the box instead of half over the edge.
            Rectangle {
              width: spark.dotSize
              height: width
              radius: width / 2
              color: Color.accent
              x: spark.width - spark.rightInset - width / 2
              y: spark.lastY - height / 2
              visible: spark.series.days && spark.series.days.length > 1
            }
          }

          Text {
            width: parent.width
            visible: !root.monthSummary.hasData && root.ledgerPath !== ""
            horizontalAlignment: Text.AlignHCenter
            text: root.ledgerPath
            color: root.contentDim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
            elide: Text.ElideMiddle
          }

          Row {
            anchors.horizontalCenter: parent.horizontalCenter
            spacing: Style.space(8)
            visible: root.monthSummary.hasData

            Text {
              text: Model.formatMoney(root.headlineSpent) + " spent"
              color: root.contentDim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.body
            }
            Text {
              text: "·"
              color: root.contentDim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.body
            }
            Text {
              text: Model.formatMoney(root.headlineIncome) + " in"
              color: root.contentDim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.body
            }
            Text {
              visible: root.monthSummary.allocated > 0
              text: "·"
              color: root.contentDim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.body
            }
            Text {
              visible: root.monthSummary.allocated > 0
              text: Model.formatMoney(root.monthSummary.allocated) + " reserved"
              color: root.reservedColor
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.body
            }
            Text {
              visible: root.monthSummary.uncategorized > 0
              text: "·"
              color: root.contentDim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.body
            }
            Text {
              visible: root.monthSummary.uncategorized > 0
              text: root.monthSummary.uncategorized + " uncategorized"
              color: root.contentDim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.body
            }
          }

          /**
           * The only thing the widget writes, and the only interaction where
           * the user is the required input. It owns its own queue and its own
           * process; the panel hands it rows and re-reads when it says so.
           */
          Local.NeedsCategory {
            id: needsCategory
            width: omakeiColumn.width
            merchants: root.uncategorized.merchants
            total: root.uncategorized.total
            pluginDir: root.pluginDir
            foreground: root.contentForeground
            dim: root.contentDim
            urgent: root.contentUrgent
            fontFamily: root.contentFontFamily
            // A write lands, or is refused; either way the ledger on disk is
            // worth re-reading. The CLI bumps the revision file too, which the
            // watch below turns into the same refresh -- this covers the write
            // that failed and bumped nothing, and costs one read.
            onWrote: root.refresh()
          }

          Column {
            width: parent.width
            spacing: Style.space(6)
            visible: root.monthSummary.setAsides && root.monthSummary.setAsides.length > 0

            Repeater {
              model: root.monthSummary.setAsides

              Row {
                required property var modelData
                width: omakeiColumn.width
                Text {
                  width: parent.width - setAsideAmount.implicitWidth
                  text: modelData.name || "Set aside"
                  color: root.contentForeground
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }
                Text {
                  id: setAsideAmount
                  text: Model.formatMoney(modelData.amount)
                  color: root.reservedColor
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.body
                }
              }
            }
          }

          Column {
            width: parent.width
            spacing: Style.space(8)
            visible: root.monthSummary.cats.length > 0

            Repeater {
              model: root.monthSummary.cats

              Column {
                required property var modelData
                width: omakeiColumn.width
                spacing: Style.space(3)

                Row {
                  width: parent.width
                  Text {
                    width: parent.width - totalLabel.implicitWidth
                    text: modelData.name
                    color: root.contentForeground
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.body
                    elide: Text.ElideRight
                  }
                  Text {
                    id: totalLabel
                    text: Model.formatMoney(modelData.total)
                    color: root.contentDim
                    font.family: root.contentFontFamily
                    font.pixelSize: Style.font.body
                  }
                }

                Rectangle {
                  width: parent.width
                  height: Style.space(3)
                  color: Style.selectedFillFor(root.contentForeground, Color.accent)

                  Rectangle {
                    width: parent.width * Math.max(0.04, modelData.total / root.maxCategory)
                    height: parent.height
                    color: Color.accent
                  }
                }
              }
            }
          }

          Column {
            width: parent.width
            spacing: Style.space(6)
            visible: root.monthSummary.recent.length > 0

            Text {
              text: "ACTIVITY"
              color: root.contentDim
              font.family: root.contentFontFamily
              font.pixelSize: Style.font.caption
              font.letterSpacing: 1
            }

            Repeater {
              model: root.monthSummary.recent

              Row {
                required property var modelData
                width: omakeiColumn.width
                spacing: Style.space(10)

                Text {
                  width: Style.space(58)
                  text: modelData.day
                  color: root.contentDim
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.bodySmall
                }
                Text {
                  width: parent.width - Style.space(58) - amountLabel.implicitWidth - Style.space(20)
                  text: modelData.description
                  color: root.contentForeground
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.body
                  elide: Text.ElideRight
                }
                Text {
                  id: amountLabel
                  text: Model.formatMoney(modelData.amount, { sign: true })
                  color: modelData.amount < 0 ? root.contentUrgent : Color.accent
                  font.family: root.contentFontFamily
                  font.pixelSize: Style.font.body
                }
              }
            }
          }

          Text {
            width: parent.width
            visible: !root.monthSummary.hasData
            wrapMode: Text.WordWrap
            text: "No ledger yet. Open Omakei and choose the folder your statements are in."
            color: root.contentDim
            font.family: root.contentFontFamily
            font.pixelSize: Style.font.body
          }

          Item {
            width: parent.width
            height: openButton.implicitHeight + Style.space(4)

            Button {
              id: openButton
              anchors.right: parent.right
              anchors.bottom: parent.bottom
              text: "Open Omakei"
              foreground: root.contentForeground
              fontFamily: root.contentFontFamily
              bordered: true
              onClicked: root.openOmakei()
            }
          }
        }
      }
    }
  }
}
