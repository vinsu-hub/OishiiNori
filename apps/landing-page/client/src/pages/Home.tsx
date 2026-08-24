/* OIshiinori style reminder: reference-faithful Japanese editorial menu, warm ivory paper, charcoal ink, OIshiinori Vermilion, asymmetric poster rhythm. */
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Clock3, Instagram, Loader2, MapPin, Menu as MenuIcon, Minus, Phone, Plus, Send, X } from "lucide-react";
import { MapView } from "@/components/Map";
import {
  ApiProduct,
  BusinessHours,
  ReservationSlot,
  ReservationStatus,
  fetchBusinessHours,
  fetchMenu,
  fetchReservationAvailability,
  submitReservation,
  fetchReservationStatus,
} from "@/lib/api";

const logo = "/logo.jpg";
const heroImage = "/products/oishii-baked-sushi.jpg";
const aboutImage = "/products/tonkatsu-ramen.jpg";
const visitImage = "/products/spicy-tuna-baked-sushi.jpg";

const shopLocation = { lat: 14.278476, lng: 121.4158777 };
const PARTY_SIZE_OPTIONS = Array.from({ length: 12 }, (_, i) => i + 1);

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
}

function peso(value: number) {
  return `₱${value.toLocaleString("en-PH", { minimumFractionDigits: 2 })}`;
}

function priceLabel(product: ApiProduct): string {
  if (product.sizes.length === 0) return "";
  const cheapest = [...product.sizes].sort((a, b) => a.price - b.price)[0];
  return product.sizes.length > 1 ? `from ${peso(cheapest.price)}` : peso(cheapest.price);
}

function formatTime12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function toast(message: string, type: "success" | "error" | "info" = "info") {
  (window as any).toast?.(message, type);
}

export default function Home() {
  // --- Live menu catalog ---
  const [products, setProducts] = useState<ApiProduct[]>([]);
  const [loadingMenu, setLoadingMenu] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState("");

  useEffect(() => {
    fetchMenu()
      .then(setProducts)
      .catch((e) => toast(e instanceof Error ? e.message : "Failed to load menu", "error"))
      .finally(() => setLoadingMenu(false));
  }, []);

  // Curated showcase, not the full catalog: up to 3 photographed items per
  // category (an unphotographed item can't be a visual "best seller" pick),
  // in the API's existing category-then-name order.
  const bestSellers = useMemo(() => {
    const byCategory = new Map<string, ApiProduct[]>();
    for (const p of products) {
      if (!p.image_path) continue;
      const list = byCategory.get(p.category) ?? [];
      if (list.length < 3) {
        list.push(p);
        byCategory.set(p.category, list);
      }
    }
    return Array.from(byCategory.values()).flat();
  }, [products]);

  // --- Business hours (real, from Settings -- see GET /public/business-hours) ---
  const [hours, setHours] = useState<BusinessHours | null>(null);

  useEffect(() => {
    fetchBusinessHours()
      .then(setHours)
      .catch(() => {
        // Non-critical -- the hero line just falls back to its static text below.
      });
  }, []);

  const hoursLabel = hours ? `${formatTime12h(hours.open_time.slice(0, 5))} — ${formatTime12h(hours.close_time.slice(0, 5))}` : "11:00 AM — 10:00 PM";

  // --- Reservation form ---
  const [partySize, setPartySize] = useState(2);
  const [resDate, setResDate] = useState(todayIso());
  const [slots, setSlots] = useState<ReservationSlot[]>([]);
  const [slotsClosed, setSlotsClosed] = useState(false);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedTime, setSelectedTime] = useState("");
  const [guestName, setGuestName] = useState("");
  const [contact, setContact] = useState("");
  const [reservationSubmitting, setReservationSubmitting] = useState(false);
  const [reservation, setReservation] = useState<ReservationStatus | null>(null);

  function loadAvailability() {
    setLoadingSlots(true);
    setSelectedTime("");
    fetchReservationAvailability(resDate, partySize)
      .then((res) => {
        setSlots(res.slots);
        setSlotsClosed(res.closed);
      })
      .catch((e) => toast(e instanceof Error ? e.message : "Failed to load availability", "error"))
      .finally(() => setLoadingSlots(false));
  }

  useEffect(() => {
    loadAvailability();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resDate, partySize]);

  useEffect(() => {
    if (!reservation || reservation.status !== "pending") return;
    const interval = setInterval(() => {
      fetchReservationStatus(reservation.id).then(setReservation).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, [reservation]);

  const handleContact = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSent(true);
  };

  async function handleReservation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTime || !guestName.trim() || !contact.trim()) return;
    setReservationSubmitting(true);
    try {
      const result = await submitReservation({
        party_size: partySize,
        reservation_date: resDate,
        start_time: `${selectedTime}:00`,
        customer_name: guestName.trim(),
        customer_phone: contact.trim(),
      });
      setReservation(result);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to submit reservation", "error");
      loadAvailability();
    } finally {
      setReservationSubmitting(false);
    }
  }

  function resetReservation() {
    setReservation(null);
    setGuestName("");
    setContact("");
    loadAvailability();
  }

  return (
    <main className="site-shell">
      <div className="paper-grain" aria-hidden="true" />
      <header className="site-header">
        <div className="nav-shell">
          <button className="mobile-toggle" aria-label={menuOpen ? "Close menu" : "Open menu"} onClick={() => setMenuOpen(!menuOpen)}>
            {menuOpen ? <X size={18} /> : <MenuIcon size={18} />}
          </button>
          <nav className={`nav-links ${menuOpen ? "is-open" : ""}`}>
            <button onClick={() => { scrollToId("home"); setMenuOpen(false); }}>Home</button>
            <button onClick={() => { scrollToId("about"); setMenuOpen(false); }}>About</button>
            <button onClick={() => { scrollToId("contact"); setMenuOpen(false); }}>Contact</button>
          </nav>
          <button className="nav-logo" onClick={() => scrollToId("home")} aria-label="Oishii Nori home">
            <img src={logo} alt="Oishii Nori logo" />
          </button>
          <nav className="nav-links nav-links-right">
            <button onClick={() => scrollToId("menu")}>Menu</button>
            <button onClick={() => scrollToId("about")}>Branches</button>
            <button className="nav-cta" onClick={() => scrollToId("reserve")}>Reserve <ArrowRight size={12} /></button>
          </nav>
        </div>
      </header>

      <section id="home" className="hero section-pad">
        <div className="hero-copy">
          <p className="eyebrow">EXCLUSIVE ROLLS<br /><span>FOR YOUR OISHII DAY</span></p>
          <h1>OIshii<br /><em>Nori</em></h1>
          <p className="hero-japanese">おいしいのり</p>
          <p className="hero-description">Rolls with a little more feeling.<br />Fresh ingredients, bright ideas,<br />and a table waiting for you.</p>
          <div className="hero-actions">
            <button className="dark-button mobile-primary" onClick={() => scrollToId("reserve")}>Reserve a table <ArrowRight size={13} /></button>
            <button className="text-button mobile-secondary" onClick={() => scrollToId("menu")}><span>View menu</span><ArrowRight size={13} /></button>
          </div>
        </div>
        <div className="hero-visual">
          <div className="hero-red-disc" />
          <img src={heroImage} alt="Assorted sushi rolls on a platter" />
          <div className="vertical-stamp">寿司<br /><small>good food, good mood</small></div>
        </div>
        <div className="hero-note">JAPANESE<br />FOOD STUDIO <span>✳</span></div>
      </section>

      <section className="mobile-features" aria-label="Why choose Oishii Nori">
        <div><span>♥</span><b>Fresh daily</b><small>新鮮な毎日</small></div>
        <div><span>●</span><b>Handcrafted</b><small>心を込めて</small></div>
        <div><span>鳥</span><b>Japanese inspired</b><small>日本のインスピレーション</small></div>
        <div><span>★</span><b>Local favorite</b><small>地元で愛されるお店</small></div>
      </section>

      <section id="menu" className="menu-section section-pad">
        <div className="section-heading-row">
          <div className="section-seal">巻<br /><small>ROLLS</small></div>
          <div>
            <p className="eyebrow">ON THE TABLE</p>
            <h2>Fresh picks,<br /><span>made daily.</span></h2>
          </div>
          <p className="heading-aside">Our best sellers, straight<br />from the kitchen.</p>
        </div>
        {loadingMenu ? (
          <p style={{ textAlign: "center", fontSize: 12, color: "var(--muted-foreground)" }}>Loading menu...</p>
        ) : (
          <div className="menu-grid">
            {bestSellers.map((product, index) => (
              <article className="menu-card" key={product.id}>
                <div className="menu-image-wrap">
                  {product.image_path ? (
                    <img src={product.image_path} alt={product.name} />
                  ) : (
                    <span className="menu-image-placeholder">{String(index + 1).padStart(2, "0")}</span>
                  )}
                  <span className="menu-number">{String(index + 1).padStart(2, "0")}</span>
                </div>
                <div className="menu-card-copy">
                  <div className="menu-card-topline"><h3>{product.name}</h3><span className="menu-category">{product.category}</span></div>
                </div>
                <div className="price-strip">{priceLabel(product)}</div>
              </article>
            ))}
          </div>
        )}
      </section>

      <section id="about" className="about-section section-pad">
        <div className="about-topline">
          <span>CRAFTED WITH ATTENTION</span><span>FROM OUR KITCHEN</span><span>OISHII NORI — EST. 2024</span>
        </div>
        <div className="about-grid">
          <div className="about-copy about-copy-left">
            <p className="eyebrow">SUSHI / ROLLS</p>
            <h2>Simple ideas.<br /><span>Sharp flavor.</span></h2>
            <p>From salmon and tuna to crunchy crabstick and avocado, our sushi is built around the things people actually want to eat: fresh, generous, and made for sharing.</p>
          </div>
          <div className="about-photo"><img src={aboutImage} alt="Oishii Nori kitchen craft" /></div>
          <div className="about-copy about-copy-right">
            <p className="eyebrow">RAMEN / HOT LINE</p>
            <h2>Warm bowls.<br /><span>Good stories.</span></h2>
            <p>Stay for the ramen, the takoyaki, the sauces, and the little extras that turn a quick bite into your favorite part of the day.</p>
          </div>
        </div>
        <div className="about-bottomline"><span>THE OISHII NORI COLLECTION</span><span className="wave-mark">〰〰〰</span><span>MADE TO BE SHARED</span></div>
      </section>

      <section className="visit-section section-pad">
        <div className="visit-actions">
          <button className="visit-pill" onClick={() => scrollToId("reserve")}><Clock3 /><span><b>Timing</b><small>Check our hours</small></span><ArrowRight /></button>
          <button className={`visit-pill ${mapOpen ? "is-open" : ""}`} onClick={() => setMapOpen((open) => !open)} aria-expanded={mapOpen}><MapPin /><span><b>{mapOpen ? "Hide map" : "Visit us"}</b><small>{mapOpen ? "Close location view" : "Open location view"}</small></span>{mapOpen ? <X /> : <ArrowRight />}</button>
          <div className="hours-card"><div><span className="hours-icon">◷</span><p><b>OPEN DAILY</b><small>{hoursLabel}</small></p></div><p className="hours-address">Pedro Guevara Ave<br />Santa Cruz, Laguna 4009</p></div>
        </div>
        <div className="visit-art"><img src={visitImage} alt="Oishii Nori sushi platter" /><div className="art-ring">おいしい<br />OISHII NORI<br />おいしい</div></div>
        {mapOpen && <div className="map-panel"><div className="map-panel-head"><div><p className="eyebrow">FIND THE KITCHEN</p><h3>Oishii Nori<br /><span>Santa Cruz.</span></h3></div><a href="https://maps.app.goo.gl/9oACBZo6tUdzyabK7" target="_blank" rel="noreferrer">Open in Maps <ArrowRight size={13} /></a></div><MapView className="oishiinori-map" lat={shopLocation.lat} lng={shopLocation.lng} zoom={17} /></div>}
      </section>

      <section id="reserve" className="reserve-section section-pad">
        <div className="reserve-copy">
          <p className="eyebrow">YOUR TABLE IS WAITING</p>
          <h2>Reserve<br /><span>a table.</span></h2>
          <p>Make room for good food, cold drinks, and the people you want around. We’ll save you a seat.</p>
          <div className="reserve-note"><span>ご予約</span><small>Reservations are held for 15 minutes.</small></div>
        </div>
        {reservation ? (
          <div className="reserve-form" style={{ justifyContent: "center" }}>
            <div className="reserve-status">
              <b>Request #{reservation.reservation_number}</b>
              <span>
                Party of {reservation.party_size} · {reservation.reservation_date} · {formatTime12h(reservation.start_time.slice(0, 5))}
              </span>
              <small>
                {reservation.status === "pending" && "PENDING — sit tight, staff are reviewing your request. This updates automatically."}
                {reservation.status === "confirmed" && "CONFIRMED — we'll see you then!"}
                {reservation.status === "declined" && `DECLINED — ${reservation.declined_reason || "please call the kitchen for help."}`}
                {reservation.status === "cancelled" && "CANCELLED"}
              </small>
              {(reservation.status === "declined" || reservation.status === "cancelled") && (
                <button className="dark-button" type="button" style={{ marginTop: 8, width: "fit-content" }} onClick={resetReservation}>
                  Book another table <ArrowRight size={13} />
                </button>
              )}
            </div>
          </div>
        ) : (
          <form className="reserve-form" onSubmit={handleReservation}>
            <div className="reserve-form-row">
              <label>
                Date
                <input required type="date" name="date" min={todayIso()} value={resDate} onChange={(e) => setResDate(e.target.value)} />
              </label>
              <label>
                Party size
                <select required name="party" value={partySize} onChange={(e) => setPartySize(Number(e.target.value))}>
                  {PARTY_SIZE_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n} guest{n > 1 ? "s" : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Time
              {slotsClosed ? (
                <select disabled><option>We're closed this day</option></select>
              ) : (
                <select
                  required
                  name="time"
                  disabled={loadingSlots}
                  value={selectedTime}
                  onChange={(e) => setSelectedTime(e.target.value)}
                >
                  <option value="" disabled>
                    {loadingSlots ? "Checking availability..." : "Select time"}
                  </option>
                  {slots.map((slot) => (
                    <option key={slot.time} value={slot.time} disabled={!slot.available}>
                      {formatTime12h(slot.time)} {!slot.available ? "(full)" : ""}
                    </option>
                  ))}
                </select>
              )}
            </label>
            <label>Name<input required name="guest" placeholder="Your name" value={guestName} onChange={(e) => setGuestName(e.target.value)} /></label>
            <label>Phone or email<input required name="contact" placeholder="How can we reach you?" value={contact} onChange={(e) => setContact(e.target.value)} /></label>
            <button className="dark-button submit-button" type="submit" disabled={!selectedTime || reservationSubmitting}>
              {reservationSubmitting ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> Sending...
                </>
              ) : (
                <>
                  Reserve now <ArrowRight size={13} />
                </>
              )}
            </button>
          </form>
        )}
      </section>

      <section id="contact" className="contact-section section-pad">
        <div className="contact-deco deco-left" /><div className="contact-deco deco-right" />
        <div className="contact-title"><p className="eyebrow">WE'RE HERE FOR YOU</p><h2>Contact<br /><span>us.</span></h2><p className="contact-kanji">寿司<br />言語</p><span className="contact-stamp">おいしい</span></div>
        <form className="contact-form" onSubmit={handleContact}>
          <label>Name<input required name="name" placeholder="Your name" /></label>
          <label>Email<input required type="email" name="email" placeholder="you@example.com" /></label>
          <label>Message<textarea required name="message" rows={3} placeholder="Tell us what you’re craving..." /></label>
          <button className="dark-button submit-button" type="submit">{sent ? "Sent — arigato" : "Submit"} <Send size={13} /></button>
        </form>
      </section>

      <footer className="site-footer">
        <div className="footer-brand"><img src={logo} alt="Oishii Nori logo" /><p>Good food, good mood.<br />See you at the table.</p></div>
        <div className="footer-links"><a href="https://instagram.com" target="_blank" rel="noreferrer"><Instagram size={14} /> Instagram</a><a href="tel:+630000000000"><Phone size={14} /> Call the kitchen</a></div>
        <div className="newsletter"><p>SUBSCRIBE TO OISHII NEWS</p><form onSubmit={(e) => { e.preventDefault(); setEmail(""); }}><input value={email} onChange={(e) => setEmail(e.target.value)} type="email" placeholder="your email" aria-label="Email for newsletter" /><button aria-label="Subscribe"><ArrowRight size={15} /></button></form><small>Fresh dispatches from the kitchen.</small></div>
        <div className="footer-bottom"><span>© 2024 Oishii Nori</span><span>寿司の専門家</span><span>Made with appetite.</span></div>
      </footer>
    </main>
  );
}
