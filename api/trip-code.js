// NomuHub project codes.
//
// A trip is labelled by what it is, not by whatever the WeTravel title
// happened to say that season: BA-EX-202608-01C is Bali / Explore, starting
// August 2026, one week long, B2C. Same scheme the Meta campaigns now use, so
// a project reads the same on the booking side and the ad side.
//
//   {DESTINATION}-{PROGRAMME}-{YYYYMM}-{WEEKS}{B2B or B2C}
//
// The two vocabularies below are the whole of it. Anything this file can't
// place keeps its original WeTravel title rather than being guessed into a
// code — a wrong code is worse than no code, since the code is what people
// will start referring to the project by.

const DESTINATIONS = [
  ['JP', ['japan']],
  ['ZNZ', ['znz', 'zanzibar', 'zanzibár']],
  ['TH', ['th', 'thai', 'thailand']],
  ['VN', ['vn', 'vietnam']],
  ['KO', ['korea']],
  ['NP', ['np', 'nepal']],
  ['KN', ['ken', 'kenya']],
  ['SAL', ['salalah', 'salahlah']],
  ['SL', ['sl', 'sri', 'lanka']],
  ['PH', ['ph', 'philippines']],
  ['BA', ['ba', 'bali']],
];

const PROGRAMMES = [
  ['WL', ['wellness']],
  ['EX', ['explore']],
  ['BL', ['building', 'build']],
  ['TA', ['teaching', 'teach']],
  ['MED', ['medical']],
];

// A corporate or university partner on the title means the trip was sold to
// an organisation rather than to individuals, which is the B2B/B2C split.
const B2B_MARKERS = [
  'b2b', 'cisco', 'kumsa', 'uos', 'sharjah', 'kbbs', 'kmssai',
  'adq', 'ega', 'etihad', 'eithad', 'eithadwe', 'university', 'hikma',
  'private', 'giving',
];

const tokens = (s) => String(s || '')
  .toLowerCase()
  .replace(/[^a-z0-9À-ɏ]+/g, ' ')
  .trim()
  .split(' ')
  .filter(Boolean);

function lookup(table, words) {
  for (const [code, spellings] of table) {
    if (words.some((w) => spellings.includes(w))) return code;
  }
  return null;
}

// The title is the authority — it's what Operations actually typed. The
// destination field is only consulted for the place, and only when the title
// didn't name one ("Safari and Maasai Trip" out of Nairobi).
function classify(trip) {
  const nameWords = tokens(trip.title || trip.name);
  const destWords = tokens(trip.destination);
  return {
    destination: lookup(DESTINATIONS, nameWords) || lookup(DESTINATIONS, destWords),
    programme: lookup(PROGRAMMES, nameWords),
    b2b: nameWords.some((w) => B2B_MARKERS.includes(w)) || !!trip.charter,
  };
}

// start is an ISO day ("2026-08-22"); weeks is how many weeks the trip runs.
function buildCode(trip, start, weeks) {
  const { destination, programme, b2b } = classify(trip);
  if (!destination || !programme) {
    return { code: null, destination, programme, b2b };
  }
  const yyyymm = String(start || '').slice(0, 7).replace('-', '');
  if (!/^\d{6}$/.test(yyyymm)) return { code: null, destination, programme, b2b };
  const count = String(Math.max(1, Number(weeks) || 1)).padStart(2, '0');
  return {
    code: `${destination}-${programme}-${yyyymm}-${count}${b2b ? 'B' : 'C'}`,
    destination,
    programme,
    b2b,
  };
}

module.exports = { buildCode, classify, DESTINATIONS, PROGRAMMES, B2B_MARKERS };
