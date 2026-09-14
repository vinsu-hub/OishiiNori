import { ArrowLeft } from "lucide-react";
import { useLocation } from "wouter";
import LegalPageLayout from "@/components/LegalPageLayout";

export default function Privacy() {
  const [, setLocation] = useLocation();
  return (
    <LegalPageLayout title="Privacy Policy">
      <button onClick={() => setLocation("/")} className="legal-back">
        <ArrowLeft size={14} /> Back to Oishii Nori
      </button>

      <p className="legal-disclaimer">
        <strong>This is a starting template, not legal advice.</strong> Bracketed
        sections need the owner's real details filled in, and a lawyer familiar
        with Philippine privacy law should review this before it's relied on
        for a real launch.
      </p>

      <p><em>Last updated: [DATE]</em></p>

      <h2>What this page covers</h2>
      <p>
        Oishii Nori ("we," "us") operates this website and the linked online
        ordering / table reservation pages. This policy explains what
        information we collect when you use them, why, and what you can do
        about it. We're a single-location restaurant in Santa Cruz, Laguna,
        Philippines, and this policy is written with the Philippine{" "}
        <strong>Data Privacy Act of 2012 (Republic Act 10173)</strong> in mind,
        not GDPR or CCPA (we don't specifically target EU or California
        visitors).
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Table reservations:</strong> your name and phone number, and
          optionally a note and an advance food order, so we can hold your
          table and contact you about it.
        </li>
        <li>
          <strong>Online / QR ordering:</strong> your name and phone number for
          delivery or pickup orders (a dine-in QR order at your table doesn't
          need these), plus a delivery address when applicable, and a proof-
          of-payment image if you pay via an online method before we confirm
          your order.
        </li>
        <li>
          <strong>Nothing else.</strong> We don't require an account, we don't
          use tracking cookies, analytics scripts, or advertising pixels of any
          kind on this site as of this writing — if that ever changes, this
          policy will be updated to say so before it happens, not after.
        </li>
      </ul>

      <h2>Why we collect it</h2>
      <p>
        Solely to fulfill your reservation or order — confirming details,
        contacting you if something changes, and (for online orders) verifying
        payment. We don't sell or share your information with third parties
        for marketing, and we don't use it for anything beyond serving the
        specific reservation or order you made.
      </p>

      <h2>How long we keep it</h2>
      <p>
        [Retention period — e.g. "reservation and order records are kept for
        our own bookkeeping for up to X years, then deleted"]. Ask us and
        we'll tell you what we still have on file.
      </p>

      <h2>Your rights</h2>
      <p>
        Under RA 10173, you can ask us what personal data we hold about you,
        ask us to correct it, or ask us to delete it (a reservation currently
        awaiting confirmation may need to be cancelled first). Reach us at{" "}
        <a href="mailto:[CONTACT EMAIL]">[CONTACT EMAIL]</a> or{" "}
        <a href="tel:+630000000000">[PHONE NUMBER]</a> — both placeholders
        until the business supplies real contact details.
      </p>

      <h2>Questions</h2>
      <p>
        This policy is a plain-language summary, not a substitute for reading
        RA 10173 itself or talking to a lawyer if you have a specific concern.
      </p>
    </LegalPageLayout>
  );
}
