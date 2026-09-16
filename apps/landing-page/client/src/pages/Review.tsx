import { useState } from "react";
import { ArrowLeft, Send, Star } from "lucide-react";
import { useLocation } from "wouter";
import { submitReview, uploadReviewPhoto } from "@/lib/api";

const MAX_LENGTH = 600;

function toast(message: string, type: "success" | "error" | "info" = "info") {
  (window as any).toast?.(message, type);
}

function generateId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// A new page (not a section on Home.tsx) for leaving a review -- public,
// unauthenticated, staged into a moderation queue (POST /public/reviews).
// Admin-only for now: nothing submitted here becomes publicly visible
// anywhere on this site yet, only in the dashboard's Customer Reviews tab.
export default function Review() {
  const [, setLocation] = useLocation();
  const [isAnonymous, setIsAnonymous] = useState(false);
  const [customerName, setCustomerName] = useState("");
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [body, setBody] = useState("");
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  // One id per page load, resent unchanged on every retry of this same
  // attempt -- same idempotency-key convention the rest of this project's
  // public write endpoints already use.
  const [idempotencyKey] = useState(generateId);

  function handlePhotoChange(file: File | null) {
    setPhotoFile(file);
    setPhotoPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return file ? URL.createObjectURL(file) : null;
    });
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (rating < 1) {
      toast("Please pick a star rating", "error");
      return;
    }
    if (!isAnonymous && !customerName.trim()) {
      toast("Please enter your name, or choose to post anonymously", "error");
      return;
    }
    if (!body.trim()) {
      toast("Please write a short review", "error");
      return;
    }
    setSubmitting(true);
    try {
      const result = await submitReview({
        is_anonymous: isAnonymous,
        customer_name: isAnonymous ? null : customerName.trim(),
        rating,
        body: body.trim(),
        idempotency_key: idempotencyKey,
      });
      if (photoFile) {
        try {
          await uploadReviewPhoto(result.id, photoFile);
        } catch (uploadError) {
          // The review itself was already recorded -- don't lose it, just
          // let the customer know the photo specifically didn't attach.
          toast(
            uploadError instanceof Error
              ? `Review submitted, but the photo didn't attach: ${uploadError.message}`
              : "Review submitted, but the photo didn't attach",
            "error"
          );
        }
      }
      setSent(true);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to submit review", "error");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f3eddb", color: "#232321", fontFamily: '"DM Sans", sans-serif' }}>
      <div style={{ maxWidth: 560, margin: "0 auto", padding: "48px 24px 80px" }}>
        <style>{`
          .review-back {
            display: inline-flex; align-items: center; gap: 8px;
            background: none; border: none; cursor: pointer;
            color: #6b6357; font-size: 13px; padding: 0; margin-bottom: 24px;
          }
          .review-stars { display: flex; gap: 6px; margin: 6px 0 4px; }
          .review-stars button { background: none; border: none; cursor: pointer; padding: 2px; }
          .review-toggle { display: flex; gap: 16px; margin-bottom: 4px; }
          .review-toggle label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: #3f3a33; cursor: pointer; }
          .review-counter { text-align: right; font-size: 11px; color: #6b6357; margin-top: -8px; }
        `}</style>

        <button onClick={() => setLocation("/")} className="review-back">
          <ArrowLeft size={14} /> Back to Oishii Nori
        </button>

        <h1 style={{ fontFamily: '"Bebas Neue", sans-serif', fontSize: 44, color: "#a51f26", margin: "0 0 8px" }}>
          Leave a review
        </h1>
        <p style={{ fontSize: 14, lineHeight: 1.7, color: "#3f3a33", marginBottom: 28 }}>
          Tell us how your visit went. A team member reviews every submission before it's kept on
          file — this isn't posted publicly.
        </p>

        {sent ? (
          <div
            style={{
              background: "#fff8e8",
              border: "1px solid #e7d9ad",
              borderRadius: 8,
              padding: "18px 20px",
              fontSize: 14,
              lineHeight: 1.6,
              color: "#3f3a33",
            }}
          >
            Thanks for the feedback — arigato! A team member will review it shortly.
          </div>
        ) : (
          <form className="contact-form" onSubmit={handleSubmit}>
            <div className="review-toggle">
              <label>
                <input type="radio" checked={!isAnonymous} onChange={() => setIsAnonymous(false)} />
                Show my name
              </label>
              <label>
                <input type="radio" checked={isAnonymous} onChange={() => setIsAnonymous(true)} />
                Post anonymously
              </label>
            </div>

            {!isAnonymous && (
              <label>
                Name
                <input
                  required
                  name="name"
                  placeholder="Your name"
                  value={customerName}
                  onChange={(e) => setCustomerName(e.target.value)}
                />
              </label>
            )}

            <label>
              Rating
              <div className="review-stars">
                {[1, 2, 3, 4, 5].map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-label={`${value} star${value === 1 ? "" : "s"}`}
                    onMouseEnter={() => setHoverRating(value)}
                    onMouseLeave={() => setHoverRating(0)}
                    onClick={() => setRating(value)}
                  >
                    <Star
                      size={26}
                      color="#a51f26"
                      fill={value <= (hoverRating || rating) ? "#a51f26" : "none"}
                    />
                  </button>
                ))}
              </div>
            </label>

            <label>
              Your review
              <textarea
                required
                name="body"
                rows={4}
                maxLength={MAX_LENGTH}
                placeholder="What did you enjoy? Anything we could do better?"
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </label>
            <p className="review-counter">
              {body.length}/{MAX_LENGTH}
            </p>

            <label>
              Photo (optional)
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={(e) => handlePhotoChange(e.target.files?.[0] ?? null)}
              />
            </label>
            {photoPreviewUrl && (
              <img
                src={photoPreviewUrl}
                alt="Review photo preview"
                style={{ width: "100%", maxWidth: 220, borderRadius: 8, display: "block" }}
              />
            )}

            <button className="dark-button submit-button" type="submit" disabled={submitting}>
              {submitting ? "Submitting..." : "Submit review"} <Send size={13} />
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
