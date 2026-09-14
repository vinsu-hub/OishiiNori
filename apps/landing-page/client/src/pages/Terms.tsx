import { ArrowLeft } from "lucide-react";
import { useLocation } from "wouter";
import LegalPageLayout from "@/components/LegalPageLayout";

export default function Terms() {
  const [, setLocation] = useLocation();
  return (
    <LegalPageLayout title="Terms &amp; Conditions">
      <button onClick={() => setLocation("/")} className="legal-back">
        <ArrowLeft size={14} /> Back to Oishii Nori
      </button>

      <p className="legal-disclaimer">
        <strong>This is a starting template, not legal advice.</strong> Bracketed
        sections need the owner's real details filled in before this is relied
        on for a real launch.
      </p>

      <p><em>Last updated: [DATE]</em></p>

      <h2>Reservations</h2>
      <p>
        A table request isn't guaranteed until we confirm it — we'll text or
        call the number you gave us if we can't. Please arrive within a
        reasonable window of your reserved time; a table held for you may be
        released to another guest if you're significantly late with no word.
        [Add a specific grace period / no-show policy here once decided.]
      </p>

      <h2>Advance orders</h2>
      <p>
        If you add food items when booking a reservation, we start preparing
        them ahead of your arrival so it's ready quickly once you're seated.
        Cancelling a reservation with an advance order attached also cancels
        that order. [Add a cancellation-window / refund policy here if advance
        orders are ever prepaid online.]
      </p>

      <h2>Online / QR ordering</h2>
      <p>
        Prices shown are current at the time you order and may change without
        notice for future orders. An order isn't final until our staff
        approves it — if an item is unexpectedly unavailable, we'll contact
        you before proceeding. Delivery fees are based on the barangay you
        select and are shown before you confirm.
      </p>

      <h2>Payment</h2>
      <p>
        We don't process card payments through this site. Cash and the online
        payment methods listed at checkout (e.g. GCash) are handled directly
        between you and our staff — this site only records that a payment was
        made, via the proof you upload or the cashier's confirmation in
        person.
      </p>

      <h2>Liability</h2>
      <p>
        [Standard liability-limitation language — consult a lawyer for
        wording appropriate to a Philippine food-service business, including
        any required allergen/food-safety disclosures.]
      </p>

      <h2>Governing law</h2>
      <p>
        These terms are governed by the laws of the Republic of the
        Philippines. Any dispute is subject to the jurisdiction of the courts
        of [CITY/PROVINCE], Philippines.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: <a href="mailto:[CONTACT EMAIL]">[CONTACT EMAIL]</a>{" "}
        or <a href="tel:+630000000000">[PHONE NUMBER]</a>.
      </p>
    </LegalPageLayout>
  );
}
