import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

BarWidget {
  id: root
  moduleName: "omakei"

  readonly property string currentMonth: Model.currentMonth()
  readonly property var monthSummary: panelLoader.item ? panelLoader.item.currentSummary : Model.emptySummary(currentMonth)
  readonly property string displayText: Model.barLabel(monthSummary)
  readonly property bool negativeNet: !!(monthSummary && monthSummary.hasData && monthSummary.net < -0.005)

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function refresh() {
    if (panelLoader.item && panelLoader.item.refresh) panelLoader.item.refresh()
  }

  function togglePanel() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  /**
   * Delegate to the panel: only it knows the plugin directory, and the opener
   * there starts the editor when nothing is serving yet.
   */
  function openOmakei() {
    if (panelLoader.item && panelLoader.item.openOmakei) panelLoader.item.openOmakei()
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open() {
    if (panelLoader.item && panelLoader.item.openFromHotkey) panelLoader.item.openFromHotkey()
    else if (panelLoader.item) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch() {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.displayText
    tooltipText: monthSummary && monthSummary.hasData
      ? (monthSummary.monthLabel + "  " + Model.formatMoney(monthSummary.spent) + " spent  ·  " + Model.formatMoney(monthSummary.income) + " in"
        + (monthSummary.allocated > 0 ? ("  ·  " + Model.formatMoney(monthSummary.allocated) + " reserved") : ""))
      : "Omakei ledger"
    active: root.negativeNet
    horizontalMargin: 8.75
    verticalPadding: 8.75

    onPressed: function(b) {
      if (b === Qt.RightButton) root.openOmakei()
      else if (b === Qt.MiddleButton) root.refresh()
      else root.togglePanel()
    }
  }
}
