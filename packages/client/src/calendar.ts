/**
 * NYSE trading calendar re-exported from `services/automation` (P0-1).
 *
 * This is the ONE documented exception to "UI tickets don't touch packages/client": the app needs
 * session-close time for the header and test-market classification, and the calendar is the shared
 * source. Re-exporting through `packages/client` keeps the app's import paths clean and ensures
 * both the app and automation use the same logic.
 */
export {
  ET_ZONE,
  isTradingDay,
  closeTimeET,
  tradingDateET,
  previousTradingDay,
  nextTradingDay,
  SUPPORTED_YEARS,
  type IsoDate,
  type CloseTime,
} from "../../../services/automation/src/calendar";
