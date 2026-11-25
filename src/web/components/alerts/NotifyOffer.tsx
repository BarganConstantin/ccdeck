// "Get an alert when a session needs you", once, under the conversation in
// Chat: Turn on switches the deck's notifications on and asks the browser, as
// Settings › Notifications does; × puts the offer away for good. Never shown
// once alerts are on, refused by the browser, turned off at launch, or in the
// desktop app (notify-offer.ts).
import { useT } from "../../i18n";
import { dismissNotifyOffer, useNotifyOffer } from "../../notify-offer";
import { KitIcon } from "../kit-icons";

export default function NotifyOffer() {
  const t = useT();
  const offer = useNotifyOffer();
  if (!offer) return null;
  return (
    <div className="ca-offer" role="note">
      <span className="ca-offer-text">{t("board.chat.alert.offer")}</span>
      <button type="button" className="btn primary ca-offer-on" onClick={() => { offer.turnOn(); dismissNotifyOffer(); }}>
        {t("board.chat.alert.offerOn")}
      </button>
      <button type="button" className="glyph-btn" aria-label={t("board.chat.alert.offerDismiss")} title={t("board.chat.alert.offerDismiss")}
        onClick={dismissNotifyOffer}>
        <KitIcon name="close" />
      </button>
    </div>
  );
}
