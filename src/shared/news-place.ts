import { visibleUserRequest } from "./calendar-clock";

/** Places a news answer can be pinned to. Matching is exact aliases only. */
const PLACES = [
  { id: "hong_kong", label: "Hong Kong", pattern: /香港|港聞|Hong Kong/i },
  { id: "macau", label: "Macau", pattern: /澳門|澳门|Macau|Macao/i },
  { id: "taiwan", label: "Taiwan", pattern: /台灣|臺灣|台湾|Taiwan/i },
  { id: "singapore", label: "Singapore", pattern: /新加坡|Singapore/i },
  {
    id: "malaysia",
    label: "Malaysia",
    pattern: /馬來西亞|马来西亚|吉隆坡|Malaysia|Kuala Lumpur/i,
  },
] as const;

type Place = (typeof PLACES)[number];

const OPENING_LENGTH = 80;

function namedPlaces(text: string): Place[] {
  return PLACES.filter((place) => place.pattern.test(text));
}

function earliestIndex(text: string, place: Place): number {
  const index = text.search(place.pattern);
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}

/** Instruction used only when the user names a place. */
export function placeSearchRule(request: string): string {
  const requested = namedPlaces(visibleUserRequest(request));
  if (!requested.length) return "";
  const names = requested.map((place) => place.label).join(", ");
  return `The user named this place: ${names}. Include that place in every web search. Use only results about that place. Results about a different place are not useful, even when the tool result is non-empty. If that place cannot be verified, say so. Do not answer with another place's news.`;
}

/** Correction after a draft answered about a different place. */
export function stalePlaceCorrection(request: string): string {
  const requested = namedPlaces(visibleUserRequest(request));
  const names =
    requested.map((place) => place.label).join(", ") ||
    "the place the user named";
  return `The previous draft answers about a different place. The user asked about ${names}. Search again for ${names} only, together with the requested date. Drop every result about another place. If nothing about ${names} can be verified, say that this place's news could not be verified. Do not summarize another place.`;
}

/** True when a named place is missing, or another place leads the answer. */
export function answerConflictsWithPlace(
  answer: string,
  request: string,
): boolean {
  const requested = namedPlaces(visibleUserRequest(request));
  if (!requested.length) return false;
  if (requested.some((place) => !place.pattern.test(answer))) return true;
  const requestedIds = new Set<string>(requested.map((place) => place.id));
  const opening = answer.slice(0, OPENING_LENGTH);
  const requestedAt = Math.min(
    ...requested.map((place) => earliestIndex(opening, place)),
  );
  const otherAt = Math.min(
    ...PLACES.filter((place) => !requestedIds.has(place.id)).map((place) =>
      earliestIndex(opening, place),
    ),
  );
  return otherAt < requestedAt;
}
