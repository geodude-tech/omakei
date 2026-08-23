import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Model.js" as Model

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
  readonly property string ledgerPath: Model.expandPath(
    (settings && settings.ledgerPath) ? settings.ledgerPath : "",
    Quickshell.env("HOME")
  )
  readonly property string appUrl: (settings && settings.appUrl) ? settings.appUrl : "http://127.0.0.1:8080/"

  property date today: new Date()
  property var ledger: null
  property string viewMonth: Model.currentMonth()
  property var monthSummary: Model.emptySummary(viewMonth)

  readonly property var currentSummary: {
    var now = Model.currentMonth(today)
    if (viewMonth === now) return monthSummary
    return Model.summarize(ledger && ledger.transactions, now, ledger && ledger.setAsides)
  }

  readonly property real maxCategory: {
    if (!monthSummary.cats || monthSummary.cats.length === 0) return 1
    return Math.max(1, monthSummary.cats[0].total)
  }

  function open() {
    openedFromHotkey = false
    setCenterHoverRevealSuppressed(false)
    root.controller.show()
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

  function close() {
    setCenterHoverRevealSuppressed(false)
    root.controller.hide()
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

  function setCenterHoverRevealSuppressed(value) {
    if (root.bar && "centerHoverRevealSuppressed" in root.bar)
      root.bar.centerHoverRevealSuppressed = value
  }

  function refresh() {
    root.today = new Date()
    ledgerFile.reload()
    if (ledgerFile.loaded) root.ingestText()
  }

  function ingestText() {
    var next = Model.parseLedger(ledgerFile.text())
    if (!next) {
      if (!root.ledger) root.applyLedger()
      return
    }
    root.ledger = next
    root.applyLedger()
  }

  function applyLedger() {
    monthSummary = Model.summarize(ledger && ledger.transactions, viewMonth, ledger && ledger.setAsides)
  }

  function moveMonth(delta) {
    viewMonth = Model.shiftMonth(viewMonth, delta)
    applyLedger()
  }

  function goToCurrentMonth() {
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

  FileView {
    id: ledgerFile
    path: root.ledgerPath
    preload: true
    blockLoading: true
    watchChanges: true
    printErrors: false
    onFileChanged: reload()
    onLoaded: root.ingestText()
    onLoadFailed: {
      if (!root.ledger) root.applyLedger()
    }
  }

  Component.onCompleted: {
    if (ledgerFile.loaded) root.ingestText()
  }

  SystemClock {
    id: clock
    precision: SystemClock.Minutes
    onDateChanged: {
      var next = Model.currentMonth(clock.date)
      if (next === Model.currentMonth(root.today)) return
      var follow = root.viewMonth === Model.currentMonth(root.today)
      root.today = clock.date
      if (follow) root.goToCurrentMonth()
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
            text: Model.formatMoney(root.monthSummary.net, { sign: true })
            color: root.netColor(root.monthSummary.net)
            font.family: root.contentFontFamily
            font.pixelSize: 42
            font.bold: true
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
              text: Model.formatMoney(root.monthSummary.spent) + " spent"
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
              text: Model.formatMoney(root.monthSummary.income) + " in"
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
            text: "No ledger yet. Open Omakei and choose a folder of statements."
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
