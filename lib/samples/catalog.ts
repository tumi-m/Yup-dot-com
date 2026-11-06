/**
 * Hand-checked connections between famous songs, shown next to what
 * MusicBrainz has (its sample data misses many well-known ones).
 *
 * Rules for an entry: the connection is widely documented (liner credits,
 * court cases, interviews, the artists themselves); both years are the first
 * release; an interpolation (replayed or re-sung, not lifted from the record)
 * says so; when it isn't clear which part was taken, the element is
 * "multiple", never a guess. No timestamps: no open source publishes them.
 * An entry we couldn't date with confidence is left out rather than guessed.
 */
import { artistKey, compact } from "./normalize";
import type { Relation, Role, SampleElement, SongRef } from "./types";

export interface CatalogEntry {
  /** The newer song: the one that samples, covers or remixes. */
  artist: string;
  title: string;
  year: number;
  /** The record it takes from. */
  sourceArtist: string;
  sourceTitle: string;
  sourceYear: number;
  /** Default: sample. */
  relation?: "sample" | "cover" | "remix";
  /** What a sample takes. Required for samples. */
  element?: SampleElement;
  note?: string;
  /** Other ways people write the newer song ("Biggie", "Hard Knock Life"). */
  aliases?: { artist?: string[]; title?: string[] };
  /** The same for the source. */
  sourceAliases?: { artist?: string[]; title?: string[] };
}

const BIGGIE = { artist: ["Biggie", "Biggie Smalls"] };
const TUPAC = { artist: ["Tupac", "Tupac Shakur"] };
const PUFF = { artist: ["Diddy", "P. Diddy", "Sean Combs"] };
const SNOOP = { artist: ["Snoop Doggy Dogg"] };
const KANYE = { artist: ["Ye"] };

export const CATALOG: CatalogEntry[] = [
  // ── Kanye West ──────────────────────────────────────────────
  { artist: "Kanye West", title: "Stronger", year: 2007, sourceArtist: "Daft Punk", sourceTitle: "Harder, Better, Faster, Stronger", sourceYear: 2001, element: "vocals-lyrics", note: "The vocoded vocal hook", aliases: KANYE },
  { artist: "Kanye West", title: "Gold Digger", year: 2005, sourceArtist: "Ray Charles", sourceTitle: "I Got a Woman", sourceYear: 1954, element: "vocals-lyrics", note: "Ray Charles's vocal; Jamie Foxx sings the hook in his style", aliases: KANYE },
  { artist: "Kanye West", title: "Through the Wire", year: 2003, sourceArtist: "Chaka Khan", sourceTitle: "Through the Fire", sourceYear: 1984, element: "vocals-lyrics", note: "Chaka Khan's vocal, sped up", aliases: KANYE },
  { artist: "Kanye West", title: "Bound 2", year: 2013, sourceArtist: "Ponderosa Twins Plus One", sourceTitle: "Bound", sourceYear: 1971, element: "vocals-lyrics", aliases: KANYE },
  { artist: "Kanye West", title: "Power", year: 2010, sourceArtist: "King Crimson", sourceTitle: "21st Century Schizoid Man", sourceYear: 1969, element: "vocals-lyrics", aliases: KANYE },
  { artist: "Kanye West", title: "Blood on the Leaves", year: 2013, sourceArtist: "Nina Simone", sourceTitle: "Strange Fruit", sourceYear: 1965, element: "vocals-lyrics", aliases: KANYE },
  { artist: "Kanye West", title: "Famous", year: 2016, sourceArtist: "Sister Nancy", sourceTitle: "Bam Bam", sourceYear: 1982, element: "vocals-lyrics", aliases: KANYE },
  { artist: "Kanye West", title: "Famous", year: 2016, sourceArtist: "Nina Simone", sourceTitle: "Do What You Gotta Do", sourceYear: 1968, element: "vocals-lyrics", aliases: KANYE },
  { artist: "Kanye West", title: "Jesus Walks", year: 2004, sourceArtist: "The ARC Choir", sourceTitle: "Walk with Me", sourceYear: 1997, element: "vocals-lyrics", aliases: KANYE },
  { artist: "Kanye West", title: "All Falls Down", year: 2004, sourceArtist: "Lauryn Hill", sourceTitle: "Mystery of Iniquity", sourceYear: 2002, element: "interpolation", note: "Re-sung by Syleena Johnson after the sample wasn't cleared", aliases: KANYE },
  { artist: "Kanye West", title: "Diamonds from Sierra Leone", year: 2005, sourceArtist: "Shirley Bassey", sourceTitle: "Diamonds Are Forever", sourceYear: 1971, element: "vocals-lyrics", aliases: KANYE },
  { artist: "Kanye West", title: "New Slaves", year: 2013, sourceArtist: "Omega", sourceTitle: "Gyöngyhajú lány", sourceYear: 1969, element: "vocals-lyrics", note: "The Hungarian band's chorus", aliases: KANYE },
  { artist: "Kanye West", title: "Good Life", year: 2007, sourceArtist: "Michael Jackson", sourceTitle: "P.Y.T. (Pretty Young Thing)", sourceYear: 1982, element: "multiple", aliases: KANYE, sourceAliases: { title: ["P.Y.T."] } },
  { artist: "Kanye West", title: "Touch the Sky", year: 2005, sourceArtist: "Curtis Mayfield", sourceTitle: "Move On Up", sourceYear: 1970, element: "hook-riff", note: "The horns", aliases: KANYE },
  { artist: "Kanye West", title: "Father Stretch My Hands, Pt. 1", year: 2016, sourceArtist: "Pastor T.L. Barrett", sourceTitle: "Father I Stretch My Hands", sourceYear: 1971, element: "vocals-lyrics", aliases: { artist: KANYE.artist, title: ["Father Stretch My Hands Pt. 1", "Father Stretch My Hands"] }, sourceAliases: { artist: ["T.L. Barrett", "Pastor T.L. Barrett and the Youth for Christ Choir"] } },
  { artist: "Kanye West", title: "Champion", year: 2007, sourceArtist: "Steely Dan", sourceTitle: "Kid Charlemagne", sourceYear: 1976, element: "vocals-lyrics", aliases: KANYE },
  { artist: "Kanye West", title: "Lost in the World", year: 2010, sourceArtist: "Bon Iver", sourceTitle: "Woods", sourceYear: 2009, element: "vocals-lyrics", aliases: KANYE },
  { artist: "Jay-Z & Kanye West", title: "Otis", year: 2011, sourceArtist: "Otis Redding", sourceTitle: "Try a Little Tenderness", sourceYear: 1966, element: "vocals-lyrics" },
  { artist: "Jay-Z & Kanye West", title: "No Church in the Wild", year: 2011, sourceArtist: "Phil Manzanera", sourceTitle: "K-Scope", sourceYear: 1978, element: "hook-riff", note: "The guitar riff" },

  // ── Hip-hop ─────────────────────────────────────────────────
  { artist: "The Notorious B.I.G.", title: "Juicy", year: 1994, sourceArtist: "Mtume", sourceTitle: "Juicy Fruit", sourceYear: 1983, element: "multiple", aliases: BIGGIE },
  { artist: "The Notorious B.I.G.", title: "Big Poppa", year: 1994, sourceArtist: "The Isley Brothers", sourceTitle: "Between the Sheets", sourceYear: 1983, element: "multiple", aliases: BIGGIE },
  { artist: "The Notorious B.I.G.", title: "Hypnotize", year: 1997, sourceArtist: "Herb Alpert", sourceTitle: "Rise", sourceYear: 1979, element: "multiple", aliases: BIGGIE },
  { artist: "The Notorious B.I.G.", title: "Mo Money Mo Problems", year: 1997, sourceArtist: "Diana Ross", sourceTitle: "I'm Coming Out", sourceYear: 1980, element: "multiple", aliases: BIGGIE },
  { artist: "2Pac", title: "California Love", year: 1995, sourceArtist: "Joe Cocker", sourceTitle: "Woman to Woman", sourceYear: 1972, element: "hook-riff", note: "The piano riff", aliases: { artist: [...TUPAC.artist, "Dr. Dre"] } },
  { artist: "2Pac", title: "Changes", year: 1998, sourceArtist: "Bruce Hornsby and the Range", sourceTitle: "The Way It Is", sourceYear: 1986, element: "multiple", note: "The piano riff, with the chorus line re-sung", aliases: TUPAC },
  { artist: "2Pac", title: "Do for Love", year: 1997, sourceArtist: "Bobby Caldwell", sourceTitle: "What You Won't Do for Love", sourceYear: 1978, element: "multiple", aliases: TUPAC },
  { artist: "Dr. Dre", title: "Nuthin' but a 'G' Thang", year: 1992, sourceArtist: "Leon Haywood", sourceTitle: "I Want'a Do Something Freaky to You", sourceYear: 1975, element: "multiple" },
  { artist: "Warren G", title: "Regulate", year: 1994, sourceArtist: "Michael McDonald", sourceTitle: "I Keep Forgettin' (Every Time You're Near)", sourceYear: 1982, element: "multiple", sourceAliases: { title: ["I Keep Forgettin'"] } },
  { artist: "Coolio", title: "Gangsta's Paradise", year: 1995, sourceArtist: "Stevie Wonder", sourceTitle: "Pastime Paradise", sourceYear: 1976, element: "interpolation", note: "Replayed and re-sung" },
  { artist: "Snoop Dogg", title: "Gin and Juice", year: 1993, sourceArtist: "Slave", sourceTitle: "Watching You", sourceYear: 1980, element: "interpolation", aliases: SNOOP },
  { artist: "Snoop Dogg", title: "Gin and Juice", year: 1993, sourceArtist: "George McCrae", sourceTitle: "I Get Lifted", sourceYear: 1974, element: "multiple", aliases: SNOOP },
  { artist: "Snoop Dogg", title: "Who Am I (What's My Name)?", year: 1993, sourceArtist: "George Clinton", sourceTitle: "Atomic Dog", sourceYear: 1982, element: "interpolation", note: "The \"bow wow wow, yippie yo, yippie yay\" line", aliases: { artist: SNOOP.artist, title: ["What's My Name"] } },
  { artist: "A Tribe Called Quest", title: "Can I Kick It?", year: 1990, sourceArtist: "Lou Reed", sourceTitle: "Walk on the Wild Side", sourceYear: 1972, element: "bass", note: "The bassline" },
  { artist: "Nas", title: "The World Is Yours", year: 1994, sourceArtist: "Ahmad Jamal", sourceTitle: "I Love Music", sourceYear: 1970, element: "hook-riff", note: "The piano" },
  { artist: "Nas", title: "N.Y. State of Mind", year: 1994, sourceArtist: "Joe Chambers", sourceTitle: "Mind Rain", sourceYear: 1978, element: "hook-riff", note: "The piano" },
  { artist: "Nas", title: "It Ain't Hard to Tell", year: 1994, sourceArtist: "Michael Jackson", sourceTitle: "Human Nature", sourceYear: 1982, element: "hook-riff" },
  { artist: "Nas", title: "Made You Look", year: 2002, sourceArtist: "The Incredible Bongo Band", sourceTitle: "Apache", sourceYear: 1973, element: "drums", note: "The bongo break" },
  { artist: "Jay-Z", title: "Hard Knock Life (Ghetto Anthem)", year: 1998, sourceArtist: "Annie (Original Broadway Cast)", sourceTitle: "It's the Hard-Knock Life", sourceYear: 1977, element: "vocals-lyrics", note: "The orphans' chorus from the Broadway cast recording", aliases: { title: ["Hard Knock Life"] }, sourceAliases: { artist: ["Annie"], title: ["It's the Hard Knock Life", "Hard Knock Life"] } },
  { artist: "Jay-Z", title: "Izzo (H.O.V.A.)", year: 2001, sourceArtist: "The Jackson 5", sourceTitle: "I Want You Back", sourceYear: 1969, element: "multiple", aliases: { title: ["Izzo"] } },
  { artist: "Jay-Z", title: "Empire State of Mind", year: 2009, sourceArtist: "The Moments", sourceTitle: "Love on a Two-Way Street", sourceYear: 1970, element: "hook-riff", note: "The piano" },
  { artist: "Jay-Z", title: "99 Problems", year: 2003, sourceArtist: "Billy Squier", sourceTitle: "The Big Beat", sourceYear: 1980, element: "drums" },
  { artist: "Wu-Tang Clan", title: "C.R.E.A.M.", year: 1993, sourceArtist: "The Charmels", sourceTitle: "As Long as I've Got You", sourceYear: 1967, element: "hook-riff", note: "The piano", aliases: { title: ["C.R.E.A.M. (Cash Rules Everything Around Me)", "Cash Rules Everything Around Me"] } },
  { artist: "Public Enemy", title: "Fight the Power", year: 1989, sourceArtist: "James Brown", sourceTitle: "Funky Drummer", sourceYear: 1970, element: "drums" },
  { artist: "Eric B. & Rakim", title: "Paid in Full", year: 1987, sourceArtist: "Dennis Edwards", sourceTitle: "Don't Look Any Further", sourceYear: 1984, element: "bass", note: "The bassline" },
  { artist: "Naughty by Nature", title: "O.P.P.", year: 1991, sourceArtist: "The Jackson 5", sourceTitle: "ABC", sourceYear: 1970, element: "multiple" },
  { artist: "House of Pain", title: "Jump Around", year: 1992, sourceArtist: "Bob & Earl", sourceTitle: "Harlem Shuffle", sourceYear: 1963, element: "hook-riff", note: "The horn intro" },
  { artist: "Kendrick Lamar", title: "King Kunta", year: 2015, sourceArtist: "James Brown", sourceTitle: "The Payback", sourceYear: 1973, element: "multiple" },
  { artist: "Kendrick Lamar", title: "Money Trees", year: 2012, sourceArtist: "Beach House", sourceTitle: "Silver Soul", sourceYear: 2010, element: "multiple" },
  { artist: "Kendrick Lamar", title: "i", year: 2014, sourceArtist: "The Isley Brothers", sourceTitle: "That Lady (Part 1 & 2)", sourceYear: 1973, element: "hook-riff", note: "The guitar riff", sourceAliases: { title: ["That Lady"] } },
  { artist: "Travis Scott", title: "SICKO MODE", year: 2018, sourceArtist: "The Notorious B.I.G.", sourceTitle: "Gimme the Loot", sourceYear: 1994, element: "vocals-lyrics", sourceAliases: BIGGIE },
  { artist: "Drake", title: "Nice for What", year: 2018, sourceArtist: "Lauryn Hill", sourceTitle: "Ex-Factor", sourceYear: 1998, element: "vocals-lyrics" },
  { artist: "Drake", title: "Hotline Bling", year: 2015, sourceArtist: "Timmy Thomas", sourceTitle: "Why Can't We Live Together", sourceYear: 1972, element: "multiple" },
  { artist: "Cardi B", title: "Bodak Yellow", year: 2017, sourceArtist: "Kodak Black", sourceTitle: "No Flockin", sourceYear: 2014, element: "interpolation", note: "The flow, credited" },
  { artist: "Lil Nas X", title: "Old Town Road", year: 2018, sourceArtist: "Nine Inch Nails", sourceTitle: "34 Ghosts IV", sourceYear: 2008, element: "hook-riff", note: "The banjo" },
  { artist: "N.W.A", title: "Straight Outta Compton", year: 1988, sourceArtist: "The Winstons", sourceTitle: "Amen, Brother", sourceYear: 1969, element: "drums", note: "The Amen break" },
  { artist: "Mobb Deep", title: "Shook Ones, Pt. II", year: 1995, sourceArtist: "Herbie Hancock", sourceTitle: "Jessica", sourceYear: 1969, element: "hook-riff", note: "The piano, slowed down", aliases: { title: ["Shook Ones Part II", "Shook Ones (Part II)", "Shook Ones Pt. 2"] } },
  { artist: "De La Soul", title: "The Magic Number", year: 1989, sourceArtist: "Bob Dorough", sourceTitle: "Three Is a Magic Number", sourceYear: 1973, element: "vocals-lyrics", note: "From Schoolhouse Rock!" },
  { artist: "De La Soul", title: "Eye Know", year: 1989, sourceArtist: "Steely Dan", sourceTitle: "Peg", sourceYear: 1977, element: "hook-riff", note: "The guitar lick" },
  { artist: "De La Soul", title: "Me Myself and I", year: 1989, sourceArtist: "Funkadelic", sourceTitle: "(Not Just) Knee Deep", sourceYear: 1979, element: "multiple", sourceAliases: { title: ["Knee Deep"] } },
  { artist: "De La Soul", title: "Me Myself and I", year: 1989, sourceArtist: "Edwin Birdsong", sourceTitle: "Rapper Dapper Snapper", sourceYear: 1979, element: "multiple" },
  { artist: "Busta Rhymes", title: "Woo Hah!! Got You All in Check", year: 1996, sourceArtist: "Galt MacDermot", sourceTitle: "Space", sourceYear: 1969, element: "multiple" },
  { artist: "Busta Rhymes", title: "Gimme Some More", year: 1998, sourceArtist: "Bernard Herrmann", sourceTitle: "Prelude (Psycho)", sourceYear: 1960, element: "hook-riff", note: "The strings from the Psycho score", sourceAliases: { title: ["Psycho", "Prelude"] } },
  { artist: "J Dilla", title: "Workinonit", year: 2006, sourceArtist: "10cc", sourceTitle: "The Worst Band in the World", sourceYear: 1974, element: "multiple" },
  { artist: "The Prodigy", title: "Smack My Bitch Up", year: 1997, sourceArtist: "Ultramagnetic MCs", sourceTitle: "Give the Drummer Some", sourceYear: 1988, element: "vocals-lyrics", note: "The title line" },
  { artist: "The Prodigy", title: "Firestarter", year: 1996, sourceArtist: "Art of Noise", sourceTitle: "Close (to the Edit)", sourceYear: 1984, element: "vocals-lyrics", note: "The \"hey, hey\" vocal stabs" },
  { artist: "The Pharcyde", title: "Passin' Me By", year: 1992, sourceArtist: "Quincy Jones", sourceTitle: "Summer in the City", sourceYear: 1973, element: "hook-riff" },
  { artist: "The Pharcyde", title: "Runnin'", year: 1995, sourceArtist: "Stan Getz & Luiz Bonfá", sourceTitle: "Saudade Vem Correndo", sourceYear: 1963, element: "hook-riff", note: "The guitar" },
  { artist: "Pete Rock & CL Smooth", title: "They Reminisce Over You (T.R.O.Y.)", year: 1992, sourceArtist: "Tom Scott and the California Dreamers", sourceTitle: "Today", sourceYear: 1967, element: "hook-riff", note: "The saxophone", aliases: { title: ["T.R.O.Y.", "They Reminisce Over You"] }, sourceAliases: { artist: ["Tom Scott"] } },
  { artist: "Ice Cube", title: "It Was a Good Day", year: 1992, sourceArtist: "The Isley Brothers", sourceTitle: "Footsteps in the Dark", sourceYear: 1977, element: "multiple" },
  { artist: "Ice Cube", title: "Check Yo Self", year: 1993, sourceArtist: "Grandmaster Flash & the Furious Five", sourceTitle: "The Message", sourceYear: 1982, element: "multiple" },
  { artist: "Tone-Loc", title: "Wild Thing", year: 1988, sourceArtist: "Van Halen", sourceTitle: "Jamie's Cryin'", sourceYear: 1978, element: "hook-riff", note: "The guitar riff" },
  { artist: "Will Smith", title: "Men in Black", year: 1997, sourceArtist: "Patrice Rushen", sourceTitle: "Forget Me Nots", sourceYear: 1982, element: "multiple" },
  { artist: "Will Smith", title: "Gettin' Jiggy wit It", year: 1997, sourceArtist: "Sister Sledge", sourceTitle: "He's the Greatest Dancer", sourceYear: 1979, element: "hook-riff" },
  { artist: "Blackstreet", title: "No Diggity", year: 1996, sourceArtist: "Bill Withers", sourceTitle: "Grandma's Hands", sourceYear: 1971, element: "multiple" },
  { artist: "Fugees", title: "Ready or Not", year: 1996, sourceArtist: "Enya", sourceTitle: "Boadicea", sourceYear: 1987, element: "hook-riff" },
  { artist: "Mario Winans", title: "I Don't Wanna Know", year: 2004, sourceArtist: "Enya", sourceTitle: "Boadicea", sourceYear: 1987, element: "hook-riff" },
  { artist: "En Vogue", title: "My Lovin' (You're Never Gonna Get It)", year: 1992, sourceArtist: "James Brown", sourceTitle: "The Payback", sourceYear: 1973, element: "hook-riff", note: "The guitar", aliases: { title: ["My Lovin'"] } },
  { artist: "Rob Base & DJ E-Z Rock", title: "It Takes Two", year: 1988, sourceArtist: "Lyn Collins", sourceTitle: "Think (About It)", sourceYear: 1972, element: "multiple" },
  { artist: "Run-DMC", title: "Peter Piper", year: 1986, sourceArtist: "Bob James", sourceTitle: "Take Me to the Mardi Gras", sourceYear: 1975, element: "drums" },
  { artist: "Ghostface Killah", title: "Daytona 500", year: 1996, sourceArtist: "Bob James", sourceTitle: "Nautilus", sourceYear: 1974, element: "multiple" },
  { artist: "Beastie Boys", title: "Rhymin & Stealin", year: 1986, sourceArtist: "Led Zeppelin", sourceTitle: "When the Levee Breaks", sourceYear: 1971, element: "drums", note: "John Bonham's drums" },
  { artist: "Afrika Bambaataa & the Soulsonic Force", title: "Planet Rock", year: 1982, sourceArtist: "Kraftwerk", sourceTitle: "Trans-Europe Express", sourceYear: 1977, element: "interpolation", note: "The melody, replayed on synth" },
  { artist: "Afrika Bambaataa & the Soulsonic Force", title: "Planet Rock", year: 1982, sourceArtist: "Kraftwerk", sourceTitle: "Numbers", sourceYear: 1981, element: "interpolation", note: "The drum-machine rhythm, replayed" },
  { artist: "Digital Underground", title: "The Humpty Dance", year: 1990, sourceArtist: "Sly & the Family Stone", sourceTitle: "Sing a Simple Song", sourceYear: 1968, element: "multiple" },
  { artist: "EPMD", title: "You Gots to Chill", year: 1988, sourceArtist: "Zapp", sourceTitle: "More Bounce to the Ounce", sourceYear: 1980, element: "multiple" },
  { artist: "Grandmaster & Melle Mel", title: "White Lines (Don't Don't Do It)", year: 1983, sourceArtist: "Liquid Liquid", sourceTitle: "Cavern", sourceYear: 1983, element: "interpolation", note: "The bassline, replayed", aliases: { artist: ["Grandmaster Flash & Melle Mel", "Melle Mel"], title: ["White Lines"] } },
  { artist: "Luniz", title: "I Got 5 on It", year: 1995, sourceArtist: "Club Nouveau", sourceTitle: "Why You Treat Me So Bad", sourceYear: 1986, element: "hook-riff" },
  { artist: "Montell Jordan", title: "This Is How We Do It", year: 1995, sourceArtist: "Slick Rick", sourceTitle: "Children's Story", sourceYear: 1988, element: "multiple" },
  { artist: "Twista", title: "Slow Jamz", year: 2003, sourceArtist: "Luther Vandross", sourceTitle: "A House Is Not a Home", sourceYear: 1981, element: "vocals-lyrics" },
  { artist: "Eminem", title: "Stan", year: 2000, sourceArtist: "Dido", sourceTitle: "Thank You", sourceYear: 1998, element: "vocals-lyrics" },
  { artist: "Eminem", title: "My Name Is", year: 1999, sourceArtist: "Labi Siffre", sourceTitle: "I Got The...", sourceYear: 1975, element: "multiple" },
  { artist: "Eminem", title: "Sing for the Moment", year: 2002, sourceArtist: "Aerosmith", sourceTitle: "Dream On", sourceYear: 1973, element: "multiple" },
  { artist: "Biz Markie", title: "Just a Friend", year: 1989, sourceArtist: "Freddie Scott", sourceTitle: "(You) Got What I Need", sourceYear: 1968, element: "interpolation", note: "The chorus, re-sung" },
  { artist: "Mase", title: "Feel So Good", year: 1997, sourceArtist: "Kool & the Gang", sourceTitle: "Hollywood Swinging", sourceYear: 1973, element: "hook-riff" },
  { artist: "Puff Daddy", title: "Come with Me", year: 1998, sourceArtist: "Led Zeppelin", sourceTitle: "Kashmir", sourceYear: 1975, element: "multiple", aliases: PUFF },
  { artist: "Puff Daddy & Faith Evans", title: "I'll Be Missing You", year: 1997, sourceArtist: "The Police", sourceTitle: "Every Breath You Take", sourceYear: 1983, element: "multiple", note: "The guitar riff, with the melody re-sung", aliases: PUFF },
  { artist: "MC Hammer", title: "U Can't Touch This", year: 1990, sourceArtist: "Rick James", sourceTitle: "Super Freak", sourceYear: 1981, element: "hook-riff", aliases: { artist: ["M.C. Hammer", "Hammer"] } },
  { artist: "Nicki Minaj", title: "Super Freaky Girl", year: 2022, sourceArtist: "Rick James", sourceTitle: "Super Freak", sourceYear: 1981, element: "hook-riff" },
  { artist: "Vanilla Ice", title: "Ice Ice Baby", year: 1990, sourceArtist: "Queen & David Bowie", sourceTitle: "Under Pressure", sourceYear: 1981, element: "bass", note: "The bassline" },
  { artist: "Sugarhill Gang", title: "Rapper's Delight", year: 1979, sourceArtist: "Chic", sourceTitle: "Good Times", sourceYear: 1979, element: "interpolation", note: "The bassline, replayed by the Sugar Hill house band" },
  { artist: "Jack Harlow", title: "First Class", year: 2022, sourceArtist: "Fergie", sourceTitle: "Glamorous", sourceYear: 2006, element: "vocals-lyrics" },

  // ── Pop, R&B and dance ──────────────────────────────────────
  { artist: "Beyoncé", title: "Crazy in Love", year: 2003, sourceArtist: "The Chi-Lites", sourceTitle: "Are You My Woman (Tell Me So)", sourceYear: 1970, element: "hook-riff", note: "The horns" },
  { artist: "Beyoncé", title: "BREAK MY SOUL", year: 2022, sourceArtist: "Robin S", sourceTitle: "Show Me Love", sourceYear: 1990, element: "interpolation" },
  { artist: "Beyoncé", title: "BREAK MY SOUL", year: 2022, sourceArtist: "Big Freedia", sourceTitle: "Explode", sourceYear: 2014, element: "vocals-lyrics" },
  { artist: "Beyoncé", title: "ALIEN SUPERSTAR", year: 2022, sourceArtist: "Right Said Fred", sourceTitle: "I'm Too Sexy", sourceYear: 1991, element: "interpolation" },
  { artist: "Destiny's Child", title: "Bootylicious", year: 2001, sourceArtist: "Stevie Nicks", sourceTitle: "Edge of Seventeen", sourceYear: 1981, element: "hook-riff", note: "The guitar riff" },
  { artist: "Rihanna", title: "Don't Stop the Music", year: 2007, sourceArtist: "Michael Jackson", sourceTitle: "Wanna Be Startin' Somethin'", sourceYear: 1982, element: "vocals-lyrics", note: "The \"mama-say mama-sa\" chant" },
  { artist: "Mariah Carey", title: "Fantasy", year: 1995, sourceArtist: "Tom Tom Club", sourceTitle: "Genius of Love", sourceYear: 1981, element: "multiple" },
  { artist: "Alicia Keys", title: "Fallin'", year: 2001, sourceArtist: "James Brown", sourceTitle: "It's a Man's Man's Man's World", sourceYear: 1966, element: "interpolation" },
  { artist: "Mary J. Blige", title: "Real Love", year: 1992, sourceArtist: "Betty Wright", sourceTitle: "Clean Up Woman", sourceYear: 1971, element: "hook-riff", note: "The guitar riff" },
  { artist: "SWV", title: "Right Here (Human Nature Remix)", year: 1993, sourceArtist: "Michael Jackson", sourceTitle: "Human Nature", sourceYear: 1982, element: "multiple" },
  { artist: "Madonna", title: "Hung Up", year: 2005, sourceArtist: "ABBA", sourceTitle: "Gimme! Gimme! Gimme! (A Man After Midnight)", sourceYear: 1979, element: "hook-riff", sourceAliases: { title: ["Gimme! Gimme! Gimme!"] } },
  { artist: "Dua Lipa", title: "Break My Heart", year: 2020, sourceArtist: "INXS", sourceTitle: "Need You Tonight", sourceYear: 1987, element: "interpolation", note: "The riff, replayed and credited" },
  { artist: "Ariana Grande", title: "7 rings", year: 2019, sourceArtist: "Rodgers & Hammerstein", sourceTitle: "My Favorite Things", sourceYear: 1959, element: "interpolation", note: "The melody, from The Sound of Music" },
  { artist: "Doja Cat", title: "Paint the Town Red", year: 2023, sourceArtist: "Dionne Warwick", sourceTitle: "Walk On By", sourceYear: 1964, element: "vocals-lyrics" },
  { artist: "David Guetta & Bebe Rexha", title: "I'm Good (Blue)", year: 2022, sourceArtist: "Eiffel 65", sourceTitle: "Blue (Da Ba Dee)", sourceYear: 1998, element: "interpolation", aliases: { title: ["I'm Good"] }, sourceAliases: { title: ["Blue"] } },
  { artist: "Flo Rida", title: "Right Round", year: 2009, sourceArtist: "Dead or Alive", sourceTitle: "You Spin Me Round (Like a Record)", sourceYear: 1984, element: "interpolation", sourceAliases: { title: ["You Spin Me Round"] } },
  { artist: "Flo Rida", title: "Good Feeling", year: 2011, sourceArtist: "Etta James", sourceTitle: "Something's Got a Hold on Me", sourceYear: 1962, element: "vocals-lyrics" },
  { artist: "Avicii", title: "Levels", year: 2011, sourceArtist: "Etta James", sourceTitle: "Something's Got a Hold on Me", sourceYear: 1962, element: "vocals-lyrics" },
  { artist: "Eminem", title: "Without Me", year: 2002, sourceArtist: "Malcolm McLaren", sourceTitle: "Buffalo Gals", sourceYear: 1982, element: "interpolation", note: "\"Two trailer park girls go round the outside\"" },
  { artist: "Daft Punk", title: "One More Time", year: 2000, sourceArtist: "Eddie Johns", sourceTitle: "More Spell on You", sourceYear: 1979, element: "multiple" },
  { artist: "Daft Punk", title: "Robot Rock", year: 2005, sourceArtist: "Breakwater", sourceTitle: "Release the Beast", sourceYear: 1980, element: "hook-riff" },
  { artist: "Daft Punk", title: "Harder, Better, Faster, Stronger", year: 2001, sourceArtist: "Edwin Birdsong", sourceTitle: "Cola Bottle Baby", sourceYear: 1979, element: "hook-riff", note: "The keyboard riff" },
  { artist: "Daft Punk", title: "Digital Love", year: 2001, sourceArtist: "George Duke", sourceTitle: "I Love You More", sourceYear: 1977, element: "hook-riff" },
  { artist: "Stardust", title: "Music Sounds Better with You", year: 1998, sourceArtist: "Chaka Khan", sourceTitle: "Fate", sourceYear: 1981, element: "hook-riff", note: "The guitar loop" },
  { artist: "Modjo", title: "Lady (Hear Me Tonight)", year: 2000, sourceArtist: "Chic", sourceTitle: "Soup for One", sourceYear: 1982, element: "hook-riff", note: "The guitar loop", aliases: { title: ["Lady"] } },
  { artist: "Fatboy Slim", title: "Praise You", year: 1998, sourceArtist: "Camille Yarbrough", sourceTitle: "Take Yo' Praise", sourceYear: 1975, element: "vocals-lyrics" },
  { artist: "Moby", title: "Natural Blues", year: 1999, sourceArtist: "Vera Hall", sourceTitle: "Trouble So Hard", sourceYear: 1937, element: "vocals-lyrics", note: "A 1937 field recording" },
  { artist: "Gotye", title: "Somebody That I Used to Know", year: 2011, sourceArtist: "Luiz Bonfá", sourceTitle: "Seville", sourceYear: 1967, element: "hook-riff", note: "The guitar figure" },
  { artist: "Jamie xx", title: "I Know There's Gonna Be (Good Times)", year: 2015, sourceArtist: "The Persuasions", sourceTitle: "Good Times", sourceYear: 1972, element: "vocals-lyrics" },
  { artist: "Missy Elliott", title: "Lose Control", year: 2005, sourceArtist: "Cybotron", sourceTitle: "Clear", sourceYear: 1983, element: "hook-riff" },
  { artist: "The Verve", title: "Bitter Sweet Symphony", year: 1997, sourceArtist: "The Andrew Oldham Orchestra", sourceTitle: "The Last Time", sourceYear: 1966, element: "hook-riff", note: "The string loop" },
  { artist: "M.I.A.", title: "Paper Planes", year: 2007, sourceArtist: "The Clash", sourceTitle: "Straight to Hell", sourceYear: 1982, element: "multiple" },

  // ── Covers and remixes ──────────────────────────────────────
  { artist: "Run-DMC", title: "Walk This Way", year: 1986, sourceArtist: "Aerosmith", sourceTitle: "Walk This Way", sourceYear: 1975, relation: "cover", note: "Recorded with Aerosmith" },
  { artist: "Fugees", title: "Killing Me Softly", year: 1996, sourceArtist: "Roberta Flack", sourceTitle: "Killing Me Softly with His Song", sourceYear: 1973, relation: "cover", note: "Roberta Flack's version; Lori Lieberman recorded it first, in 1972", sourceAliases: { title: ["Killing Me Softly"] } },
  { artist: "Whitney Houston", title: "I Will Always Love You", year: 1992, sourceArtist: "Dolly Parton", sourceTitle: "I Will Always Love You", sourceYear: 1974, relation: "cover" },
  { artist: "Soft Cell", title: "Tainted Love", year: 1981, sourceArtist: "Gloria Jones", sourceTitle: "Tainted Love", sourceYear: 1964, relation: "cover" },
  { artist: "Johnny Cash", title: "Hurt", year: 2002, sourceArtist: "Nine Inch Nails", sourceTitle: "Hurt", sourceYear: 1994, relation: "cover" },
  { artist: "Jeff Buckley", title: "Hallelujah", year: 1994, sourceArtist: "Leonard Cohen", sourceTitle: "Hallelujah", sourceYear: 1984, relation: "cover" },
  { artist: "The Jimi Hendrix Experience", title: "All Along the Watchtower", year: 1968, sourceArtist: "Bob Dylan", sourceTitle: "All Along the Watchtower", sourceYear: 1967, relation: "cover", aliases: { artist: ["Jimi Hendrix"] } },
  { artist: "Sinéad O'Connor", title: "Nothing Compares 2 U", year: 1990, sourceArtist: "The Family", sourceTitle: "Nothing Compares 2 U", sourceYear: 1985, relation: "cover" },
  { artist: "Sugarhill Gang", title: "Apache", year: 1981, sourceArtist: "The Incredible Bongo Band", sourceTitle: "Apache", sourceYear: 1973, relation: "cover", note: "Replayed by the Sugar Hill house band, with raps" },
  { artist: "DNA", title: "Tom's Diner", year: 1990, sourceArtist: "Suzanne Vega", sourceTitle: "Tom's Diner", sourceYear: 1987, relation: "remix", note: "Vega's a cappella over a new beat", aliases: { artist: ["DNA feat. Suzanne Vega"] } },
];

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

const length = (s: string) => Array.from(s).length;

/** One string inside the other, only when the shorter is long enough to mean something. */
function contains(a: string, b: string): boolean {
  const [short, long] = length(a) <= length(b) ? [a, b] : [b, a];
  return length(short) >= 6 && length(short) / length(long) >= 0.6 && long.includes(short);
}

/** "Hard Knock Life (Ghetto Anthem)" → "Hard Knock Life". */
function withoutBrackets(text: string): string {
  return text.replace(/\s*[([][^()[\]]*[)\]]\s*/g, " ").trim();
}

/** The names in a credit: "Jay-Z & Kanye West feat. Frank Ocean" → each of them. */
export function creditNames(credit: string): string[] {
  return credit
    .split(/\s+(?:feat\.?|ft\.?|featuring|with|vs\.?)\s+|\s*(?:,|&|\band\b|\+)\s*/i)
    // A lower-case x only: "Lil Nas X" keeps its X.
    .flatMap((s) => s.split(/\s+[x×]\s+/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Same song title: equal after normalising (with or without a bracketed
 * part on the asked side), equal to an alias, or one inside the other when
 * the shorter is at least 6 characters and 60% of the longer.
 */
export function titleMatches(asked: string, title: string, aliases: string[] = []): boolean {
  const q = [...new Set([compact(asked), compact(withoutBrackets(asked))])].filter(Boolean);
  const e = [compact(title), ...aliases.map(compact)].filter(Boolean);
  if (q.some((x) => e.includes(x))) return true;
  return q.some((x) => e.some((y) => contains(x, y)));
}

/** Same artist: the whole credit, or any one name in it, matches; the same 6-character guard for containment. */
export function artistMatches(asked: string, artist: string, aliases: string[] = []): boolean {
  const q = [asked, ...creditNames(asked)].map(artistKey).filter(Boolean);
  const e = [artist, ...creditNames(artist), ...aliases].map(artistKey).filter(Boolean);
  if (q.some((x) => e.includes(x))) return true;
  return contains(artistKey(asked), artistKey(artist));
}

const FORWARD: Record<NonNullable<CatalogEntry["relation"]>, Role> = { sample: "samples", cover: "covers", remix: "remixOf" };
const BACKWARD: Record<NonNullable<CatalogEntry["relation"]>, Role> = { sample: "sampledBy", cover: "coveredBy", remix: "remixedBy" };

/** Everything the list knows about one song, both ways: what it takes from, and what took from it. */
export function lookupCatalog(song: Pick<SongRef, "artist" | "title">, catalog: CatalogEntry[] = CATALOG): Relation[] {
  if (!song.artist.trim() || !song.title.trim()) return [];
  const out: Relation[] = [];
  for (const e of catalog) {
    const relation = e.relation ?? "sample";
    const element = relation === "sample" ? (e.element ?? "multiple") : null;
    if (titleMatches(song.title, e.title, e.aliases?.title) && artistMatches(song.artist, e.artist, e.aliases?.artist)) {
      out.push({ role: FORWARD[relation], artist: e.sourceArtist, title: e.sourceTitle, year: e.sourceYear, element, note: e.note ?? null, source: "catalog" });
    }
    if (
      titleMatches(song.title, e.sourceTitle, e.sourceAliases?.title) &&
      artistMatches(song.artist, e.sourceArtist, e.sourceAliases?.artist)
    ) {
      out.push({ role: BACKWARD[relation], artist: e.artist, title: e.title, year: e.year, element, note: e.note ?? null, source: "catalog" });
    }
  }
  return out;
}

/** The year the list gives this song, if it has it. */
export function catalogYear(song: Pick<SongRef, "artist" | "title">, catalog: CatalogEntry[] = CATALOG): number | null {
  for (const e of catalog) {
    if (titleMatches(song.title, e.title, e.aliases?.title) && artistMatches(song.artist, e.artist, e.aliases?.artist)) return e.year;
    if (titleMatches(song.title, e.sourceTitle, e.sourceAliases?.title) && artistMatches(song.artist, e.sourceArtist, e.sourceAliases?.artist)) {
      return e.sourceYear;
    }
  }
  return null;
}
