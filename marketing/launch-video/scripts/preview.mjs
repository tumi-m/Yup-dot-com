// Serves the project so the film can be previewed in a browser.
//   node scripts/preview.mjs   then open the printed URL (add ?fmt=9x16 for the vertical cut, ?t=12.5 to jump)
import { serve } from "./lib.mjs";

const srv = await serve();
console.log(`${srv.url}/film/film.html?fmt=16x9`);
console.log(`${srv.url}/film/film.html?fmt=9x16`);
console.log("space play/pause, arrows step a frame, shift+arrows a beat, R replays. Ctrl+C to stop.");
