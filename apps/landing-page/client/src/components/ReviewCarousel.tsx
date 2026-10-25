import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import type { PublicReview } from "@/lib/api";

const CARD_WIDTH = 316; // 300px card + 16px gap
const SECONDS_PER_CARD = 6;
// One loop of cards must be wider than the widest carousel, or a short list
// leaves an empty gap before it wraps around.
const MIN_LOOP_WIDTH = 1400;

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function ReviewCard({ review }: { review: PublicReview }) {
  return (
    <figure className="rv-card">
      <div className="rv-card-stars" aria-label={`${review.rating} out of 5 stars`}>
        {[1, 2, 3, 4, 5].map((value) => (
          <Star key={value} size={15} color="#a51f26" fill={value <= review.rating ? "#a51f26" : "none"} aria-hidden />
        ))}
      </div>
      <blockquote>{review.body}</blockquote>
      {review.photo_url && <img src={review.photo_url} alt={`Photo from ${review.name}'s visit`} loading="lazy" />}
      <figcaption>— {review.name}</figcaption>
    </figure>
  );
}

// Reviews slide right to left in a seamless loop: the cards are rendered
// twice and the track moves by exactly one copy (-50%), then starts over.
// Hover or keyboard focus pauses it; reduced motion gets a plain scroll row.
export function ReviewCarousel({ reviews }: { reviews: PublicReview[] }) {
  const reducedMotion = usePrefersReducedMotion();
  if (reviews.length === 0) return null;

  if (reducedMotion) {
    return (
      <div className="rv-marquee rv-static">
        <div className="rv-track">
          {reviews.map((review) => <ReviewCard key={review.id} review={review} />)}
        </div>
      </div>
    );
  }

  const repeats = Math.max(1, Math.ceil(MIN_LOOP_WIDTH / (reviews.length * CARD_WIDTH)));
  const loop = Array.from({ length: repeats }, () => reviews).flat();
  return (
    <div className="rv-marquee">
      <div className="rv-track" style={{ animationDuration: `${loop.length * SECONDS_PER_CARD}s` }}>
        {loop.map((review, i) => (
          <div key={`a${i}`} aria-hidden={i >= reviews.length || undefined} className="rv-slot">
            <ReviewCard review={review} />
          </div>
        ))}
        {loop.map((review, i) => (
          <div key={`b${i}`} aria-hidden className="rv-slot">
            <ReviewCard review={review} />
          </div>
        ))}
      </div>
    </div>
  );
}
