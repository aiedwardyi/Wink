/** Friends-desktop chrome: hide power-user surfaces without deleting them.
 * Flip a function to true to put that control back on the idle UI. */

export function showBotVoiceAndStartupSettings(): boolean {
  return false;
}

export function showChannelCallControl(): boolean {
  return false;
}

/** Phone/companion stays parked on the friends idle surface. */
export function showSidebarPhone(): boolean {
  return false;
}


/** Per-bot tokens/turns/cost table under Settings → Usage. */
export function showUsagePerBotTable(): boolean {
  return false;
}

/** Share Terminal with Chat where it can't be turned on (phone, browser). */
export function showDisabledShareTerminal(): boolean {
  return false;
}

/** File-type line under Upload; a rejected file still says why. */
export function showAvatarFormatsHint(): boolean {
  return false;
}

export function showBotMenuCopy(): boolean {
  return false;
}

export function showNewMenuExport(): boolean {
  return false;
}

export function showPhoneDrawerCollapse(): boolean {
  return false;
}

/** Find in the chat header; Ctrl+F still opens it. */
export function showChatHeaderFind(): boolean {
  return false;
}

export function showTouchPickerLegend(): boolean {
  return false;
}

export function showTerminalAlerts(): boolean {
  return false;
}

export function showTerminalColors(): boolean {
  return false;
}
