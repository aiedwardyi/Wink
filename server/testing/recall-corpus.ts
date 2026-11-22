// What the review gates of #1991 asked recall, as note files and messages: their probes, every gate T
// message among them, and their seeded plans. A test holds recall to what 83f790c87 returned on each.
import type { NoteFile } from "../memory-lookup.ts";

export type RecallCase = { family: string; name: string; files: NoteFile[]; messages: string[] };
type Files = Record<string, [string[], number]>;
type Run = (name: string, files: Files, queries: string[]) => void;
const MAX_CORPUS_BYTES = 2 * 1024 * 1024;

function probe1(run: Run) {
  const supplies = (n: number) => Array.from({ length: n }, (_, i) => "- Supply " + i + " crate" + i + " tent" + i);
  const outbound = "- Ferry ticket: outbound from Silver Pier on 2026-11-20";
  const inbound = "- Ferry ticket: return from Amber Quay on 2026-11-20 (noted 2026-10-15)";
  for (const [n, rows] of [[inbound], [outbound, inbound], [inbound, outbound], [outbound, inbound, outbound]].entries()) run("P1." + n, { "connections.md": [rows, 15] }, ["amber quay", "silver pier", "ferry ticket"]);
  const earlier = "- Station assignment: Silver Pier from 2026-10-01 (noted 2026-10-02)";
  const newer = "- Station assignment: Amber Quay (noted 2026-10-15)";
  for (const stamp of ["2026-10-02", "2026-13-02", "2026-02-30", "2026-00-10", "2026-10-00", "2026-10-32"]) run("P2 " + stamp, { "connections.md": [[earlier.replace("noted 2026-10-02", "noted " + stamp), newer], 16] }, ["amber quay", "silver pier", "station assignment"]);
  const old = "- Ferry booking: provisional Silver Pier";
  const saved = "- Ferry booking: confirmed Amber Quay for 2026-11-20 (noted 2026-10-15)";
  const rain = "- Packs a raincoat";
  // SAFETY: every layout maps a file name to its rows and day, the Files shape; the literal only narrows it to a union of key sets.
  for (const [n, files] of ([
    { "travel.md": [[old, saved, rain], 16] },
    { "travel.md": [[saved, old, rain], 16] },
    { "travel.md": [[old, saved, old, rain], 16] },
    { "travel.md": [[old, rain], 16], "booking.md": [[saved], 15] },
  ] as Files[]).entries()) run("P3." + n, files, ["amber quay", "silver pier", "ferry booking"]);
  const acme = "- Research station: Cobalt Acme (noted 2026-10-15)";
  const globex = "- Research station: Indigo Globex (noted 2026-10-15)";
  for (const count of [24, 128]) for (const rows of [[acme, globex], [globex, acme, globex], [acme, globex, acme], [globex, acme]]) run("P4 " + count + " " + rows.map((r) => r.includes("Acme") ? "A" : "G").join(""), { "connections.md": [[...supplies(count), ...rows], 15] }, ["cobalt acme", "indigo globex", "research station"]);
  const smith = "- Dentist: Dr. Smith on Main Street";
  const lee = "- Dentist: Dr. Lee on Harbor Road, cleaning 2026-11-20 (noted 2026-10-10)";
  run("SmithLee unstamped Smith", { "health.md": [[smith, lee], 15] }, ["dentist main street", "dentist harbor road", "dentist"]);
  run("SmithLee Smith noted 10-15", { "health.md": [[smith + " (noted 2026-10-15)", lee], 15] }, ["dentist main street", "dentist harbor road"]);
  run("SmithLee +filler", { "health.md": [[...supplies(128), smith, lee], 15] }, ["dentist main street", "dentist harbor road", "who is my dentist"]);
  const standup = ["- Standup: moved to 10am (noted 2026-10-12)", "- Standup: starts 9am sharp (noted 2026-10-12)", "- Standup: moved to 10am (noted 2026-10-12)"];
  run("Tie 10,9,10", { "team.md": [[...supplies(120), ...standup], 20] }, ["standup moved 10am or 9am sharp", "standup starts 9am sharp", "standup moved 10am", "when is standup"]);
  run("Tie 9,10,9", { "team.md": [[...supplies(120), standup[1]!, standup[0]!, standup[1]!], 20] }, ["standup moved 10am or 9am sharp", "standup starts 9am sharp", "standup moved 10am"]);
  run("Tie 9,10", { "team.md": [[...supplies(120), standup[1]!, standup[0]!], 20] }, ["standup moved 10am or 9am sharp", "standup starts 9am sharp", "standup moved 10am"]);
  // Q hunt: an older stamped row naming a later day, a later-noted bot row, and an unstamped row
  const amber10 = "- Ferry booking: confirmed Amber Quay for 2026-11-20 (noted 2026-10-10)";
  const cedar15 = "- Ferry booking: moved to Cedar Dock (noted 2026-10-15)";
  for (const day of [15, 16]) for (const [n, rows] of [[old, amber10, cedar15], [amber10, cedar15, old], [amber10, cedar15]].entries()) run("Q1 day" + day + "." + n, { "travel.md": [[...rows, ...(day === 16 ? [rain] : [])], day] }, ["amber quay", "cedar dock", "silver pier", "ferry booking"]);
  run("Q1 two files", { "travel.md": [[old, rain], 16], "booking.md": [[amber10, cedar15], 15] }, ["amber quay", "cedar dock", "silver pier", "ferry booking"]);
}

function probe2(run: Run) {
  const supplies = (n: number) => Array.from({ length: n }, (_, i) => "- Supply " + i + " crate" + i + " tent" + i);

  const old = "- Ferry booking: provisional Silver Pier";
  const amber = "- Ferry booking: confirmed Amber Quay for 2026-11-20 (noted 2026-10-10)";
  const cedar = "- Ferry booking: moved to Cedar Dock (noted 2026-10-15)";
  const rain = "- Packs a raincoat";
  const qs = ["amber quay", "cedar dock", "silver pier", "ferry booking"];
  const O = "auto-notes-overflow.md";
  run("A0 start: hand row + Amber, file day 10", { [O]: [[old, amber], 10] }, qs);
  run("A1 Cedar saved 10-15, file day 15", { [O]: [[old, amber, cedar], 15] }, qs);
  run("A2 then a hand line, file day 16", { [O]: [[old, amber, cedar, rain], 16] }, qs);
  run("B then a bot line noted 10-16, file day 16", { [O]: [[old, amber, cedar, rain + " (noted 2026-10-16)"], 16] }, qs);
  run("C hand row in travel.md edited 16", { [O]: [[amber, cedar], 15], "travel.md": [[old, rain], 16] }, qs);
  run("D control: no Cedar", { [O]: [[old, amber, rain], 16] }, qs);
  run("E control: no hand row", { [O]: [[amber, cedar, rain], 16] }, qs);
  run("A3 order: Cedar, Amber, hand row", { [O]: [[cedar, amber, old, rain], 16] }, qs);
  const outbound = "- Ferry ticket: outbound from Silver Pier on 2026-11-20";
  const inbound = "- Ferry ticket: return from Amber Quay on 2026-11-20 (noted 2026-10-15)";
  const deck = "- Ferry ticket: car deck upgrade paid (noted 2026-10-16)";
  const tq = ["amber quay", "silver pier", "car deck upgrade", "ferry ticket"];
  run("G0 gate P fixture: outbound + return", { "connections.md": [[outbound, inbound], 15] }, tq);
  run("G1 plus one later note of the label", { "connections.md": [[outbound, inbound, deck], 16] }, tq);
  run("G2 same, later note first in file", { "connections.md": [[deck, outbound, inbound], 16] }, tq);
  run("G3 later note in the overflow file", { "connections.md": [[outbound, inbound], 15], [O]: [[deck], 16] }, tq);
  const slate = (day: string) => "- Research station: moved to Slate Hollow on 2027-01-15 (noted 2026-10-" + day + ")";
  const jade = "- Station assignment: confirmed Jade Wharf on 2026-11-26";
  const lilac = "- Station assignment: provisional Lilac Moor since 09-14 (noted 2026-10-16)";
  const sq = ["jade wharf", "station assignment jade wharf", "slate hollow"];
  run("F1 corpus edge, fuzz plan", { "side0.md": [[...supplies(45), slate("17"), jade, lilac], 17], [O]: [[slate("16"), slate("14")], 20], "notes2.md": [["- Research station: Cedar Dock", jade], 19] }, sq);
  run("F2 control: two older Slate rows taken out by hand", { "side0.md": [[...supplies(45), slate("17"), jade, lilac], 17], "notes2.md": [["- Research station: Cedar Dock", jade], 19] }, sq);
  run("F3 same as F1 with 2 more supply rows", { "side0.md": [[...supplies(47), slate("17"), jade, lilac], 17], [O]: [[slate("16"), slate("14")], 20], "notes2.md": [["- Research station: Cedar Dock", jade], 19] }, sq);

  const outbound14 = "- Ferry ticket: outbound from Silver Pier on 2026-11-20 (noted 2026-10-14)";
  const inbound15 = "- Ferry ticket: return from Amber Quay on 2026-11-20 (noted 2026-10-15)";
  const outboundHand = "- Ferry ticket: outbound from Silver Pier";
  const deck16 = "- Ferry ticket: car deck upgrade paid (noted 2026-10-16)";
  const tq2 = ["amber quay", "silver pier", "car deck upgrade", "ferry ticket"];
  const OV = "auto-notes-overflow.md";
  run("R1 two bot tickets, both name Nov 20, noted Oct 14 and Oct 15", { [OV]: [[outbound14, inbound15], 15] }, tq2);
  run("R1b same, return first in file", { [OV]: [[inbound15, outbound14], 15] }, tq2);
  run("R1c same, two files", { "connections.md": [[outbound14], 14], [OV]: [[inbound15], 15] }, tq2);
  run("R2 return noted Oct 15 + deck noted Oct 16, no hand row", { [OV]: [[inbound15, deck16], 16] }, tq2);
  run("R3 hand outbound (no day in words), return, deck, file day 16", { [OV]: [[outboundHand, inbound15, deck16], 16] }, tq2);
  run("R3b same, file day 17", { [OV]: [[outboundHand, inbound15, deck16], 17] }, tq2);
  run("R4 control: two bot tickets, no day in words", { [OV]: [["- Ferry ticket: outbound from Silver Pier (noted 2026-10-14)", "- Ferry ticket: return from Amber Quay (noted 2026-10-15)"], 15] }, tq2);
  const amberR = "- Ferry booking: confirmed Amber Quay for 2026-11-20 (noted 2026-10-10)";
  const cedarR = "- Ferry booking: moved to Cedar Dock (noted 2026-10-15)";
  const bq = ["amber quay", "cedar dock", "silver pier", "ferry booking"];
  run("R5 two bookings, no hand row", { [OV]: [[amberR, cedarR], 15] }, bq);
  run("R6 hand row in an older file (day 12), two bookings", { "travel.md": [["- Ferry booking: provisional Silver Pier"], 12], [OV]: [[amberR, cedarR], 15] }, bq);
  run("R7 same-day pair, one names Nov 20", { [OV]: [["- Ferry booking: confirmed Amber Quay for 2026-11-20 (noted 2026-10-15)", "- Ferry booking: car deck space added (noted 2026-10-15)"], 15] }, ["amber quay", "car deck space", "ferry booking"]);
  run("R8 three tickets same Nov 20, noted 13/14/15", { [OV]: [["- Ferry ticket: cabin 12 on 2026-11-20 (noted 2026-10-13)", outbound14, inbound15], 15] }, ["cabin 12 ferry", "silver pier", "amber quay", "ferry ticket"]);
}

function probeL(run: Run) {


  const sup = (n: number) => Array.from({ length: n }, (_, i) => "- Supply " + i + " crate" + i + " tent" + i);
  const DQ = ["onyx mill", "amber quay", "dentist", "dentist amber quay", "dentist onyx mill", "who is my dentist"];
  const onyx = "- Dentist: Onyx Mill on 2026-11-25 (noted 2026-10-11)", amberS = "- Dentist: provisional Amber Quay on 2026-11-25 (noted 2026-10-16)", amberU = "- Dentist: provisional Amber Quay on 2026-11-25";
  run("L85 fuzz plan 85 as generated (24 filler)", { "side0.md": [[...sup(24), "- Dentist: provisional Cedar Dock", amberS, amberU, onyx], 10], "auto-notes-overflow.md": [[amberU, amberU, "- Dentist: Coral Bend from 2026-10-12 (noted 2026-10-11)"], 15] }, [...DQ, "cedar dock", "coral bend"]);
  for (const n of [0, 24, 45, 60, 128]) run("LA older note + later note saved in two files, filler " + n, { "side0.md": [[...sup(n), onyx, amberS], 16], "auto-notes-overflow.md": [[amberS], 16] }, DQ);
  run("LB control: later note in one file only, filler 24", { "side0.md": [[...sup(24), onyx, amberS], 16] }, DQ);
  run("LC later note + the same line by hand in another file, filler 24", { "side0.md": [[...sup(24), onyx, amberS], 16], "people.md": [[amberU], 16] }, DQ);
  run("LD no day in the words (control), later note in two files, filler 24", { "side0.md": [[...sup(24), "- Dentist: Onyx Mill (noted 2026-10-11)", "- Dentist: provisional Amber Quay (noted 2026-10-16)"], 16], "auto-notes-overflow.md": [["- Dentist: provisional Amber Quay (noted 2026-10-16)"], 16] }, DQ);
  const TQ = ["pearl cove", "opal gate", "slate hollow", "ferry ticket", "ferry ticket slate hollow", "what ferry ticket do i have"];
  run("L55 fuzz plan 55 ferry rows, overflow copy in a second memory file (24 filler)", { "side0.md": [[...sup(24), "- Ferry ticket: provisional Pearl Cove on 2026-11-20 (noted 2026-10-10)", "- Ferry ticket: Opal Gate on 2026-11-20 (noted 2026-10-10)", "- Ferry ticket: moved to Slate Hollow on 2026-11-20 (noted 2026-10-12)"], 16], "auto-notes-overflow.md": [["- Ferry ticket: moved to Slate Hollow on 2026-11-20 (noted 2026-10-12)"], 15] }, TQ);
}

function probeN(run: Run) {


  const FILLER = Array.from({ length: 120 }, (_, n) => "- Filler kettle" + n + " harbor" + n + " lantern" + n + " note");
  for (const stamp of ["2926-10-02", "2126-10-02", "2100-01-01", "2099-12-31", "1999-10-02"]) run("N2 hand stamp " + stamp, { "connections.md": [["- Station assignment: Silver Pier (noted " + stamp + ")", "- Station assignment: Amber Quay (noted 2026-10-15)"], 16] }, ["amber quay", "silver pier", "station assignment"]);
  const big = (top: string, tail: string[]) => [top, ...FILLER, "- pad " + "x".repeat(2 * 1024 * 1024), ...tail];
  run("N3 file past 2 MB, unstamped Dr. Old at its top, edited day 20", { "archive.md": [big("- Dentist: Dr. Old Ashford", ["- Packs a raincoat"]), 20], "health.md": [["- Dentist: Dr. Current Brookline (noted 2026-10-12)"], 12] }, ["dentist current brookline", "dentist old ashford", "who is my dentist"]);
  run("N3s same, Dr. Old stamped Oct 15, its newer row past 2 MB", { "archive.md": [big("- Dentist: Dr. Old Ashford (noted 2026-10-15)", ["- Dentist: Dr. New Calder (noted 2026-10-20)"]), 20], "health.md": [["- Dentist: Dr. Current Brookline (noted 2026-10-12)"], 12] }, ["dentist current brookline", "dentist old ashford", "dentist new calder", "who is my dentist"]);
  run("N3u same file past 2 MB alone, hand row only there", { "archive.md": [big("- Dentist: Dr. Old Ashford", ["- Packs a raincoat"]), 20] }, ["dentist old ashford"]);
  const row = "- Checklist | verify recipient address and invoice totals before dispatch";
  run("N5 row copied under a second heading", { "runbook.md": [["# Billing", row, "", "# Releases", row, "", "# Notes", "- Deploy: releases happen on Tuesday", ...FILLER], 15] }, ["releases verify invoice dispatch", "billing verify invoice dispatch"]);
}

function probeProof(run: Run) {

  const fixture={
   "roster.md":[["- Volunteer rota: evening pickup","- Volunteer rota: bring spare keys"],16],
   "plan.md":[["- Destination: Harbor on 2026-11-28 (noted 2026-10-10)","- Activity: Tour on 2026-11-28 (noted 2026-10-10)","- Destination: Harbor on 2026-11-28 (noted 2026-10-11)","- Activity: Tour on 2026-11-28 (noted 2026-10-11)"],16]
  } satisfies Files;
  const target="is the evening rota at the harbor for the tour";
  run("six saved rows",fixture,[target]);
}

function probeS(run: Run) {


  const sup = (n: number) => Array.from({ length: n }, (_, i) => "- Supply " + i + " crate" + i + " tent" + i);
  // S1 two notes of a two-word label name the same day; the later one corrects the older
  const onyxB = "- Ferry booking: Onyx Mill on 2026-11-25 (noted 2026-10-11)", amberB = "- Ferry booking: moved to Amber Quay on 2026-11-25 (noted 2026-10-16)";
  const BQ = ["ferry booking", "where is my ferry booking", "onyx mill", "amber quay", "ferry booking amber quay"];
  for (const n of [0, 24, 60]) {
    run("S1 older then later, same day named, filler " + n, { "side0.md": [[...sup(n), onyxB, amberB], 16] }, BQ);
    run("S1r later first in file, filler " + n, { "side0.md": [[...sup(n), amberB, onyxB], 16] }, BQ);
  }
  // S2 one label holds many rows that share words; the message names another note and those words
  const chores = ["Alice", "Bruno", "Carla", "Dmitri", "Elena", "Farid", "Greta", "Hiro", "Ines", "Jonas", "Kira", "Luca", "Mona", "Nils", "Olga", "Pavel", "Quinn", "Rosa", "Sven", "Tara"].map((name) => "- Chores: " + name + " weekly kitchen rota");
  const dentist = "- Dentist: Onyx Mill on 2026-11-25 (noted 2026-10-11)";
  const CQ = ["dentist onyx mill", "is the dentist at onyx mill before my weekly kitchen rota", "dentist onyx mill weekly kitchen rota", "dentist onyx mill weekly kitchen rota chores", "weekly kitchen rota", "chores rota", "alice kitchen rota"];
  run("S2 dentist note + 20 chore rows of one label", { "side0.md": [[dentist, ...chores], 16] }, CQ);
  run("S2 same in a table", { "side0.md": [["| Topic | Note |", "| --- | --- |", "| Dentist | Onyx Mill on 2026-11-25 (noted 2026-10-11) |", ...chores.map((row) => "| Chores | " + row.slice(10) + " |")], 16] }, CQ);
  run("S2 control: chore rows with no shared label", { "side0.md": [[dentist, ...chores.map((row) => row.replace("- Chores: ", "- "))], 16] }, CQ);
  // S3 a profile list under one label
  const facts = ["likes green tea in the morning", "likes black coffee after lunch", "works from the harbor office on mondays", "works from home on fridays", "prefers short answers", "prefers dark mode", "has a sister called Mona", "has a dog called Biscuit", "plays tennis on sundays", "plays chess online", "drives a blue hatchback", "reads crime novels"].map((fact) => "- User: " + fact);
  run("S3 twelve facts under one label", { "side0.md": [facts, 16] }, ["user likes", "what does the user like", "user works", "green tea", "user prefers answers", "tell me about the user", "dog biscuit", "user has"]);
  run("S3 control: same facts, no label", { "side0.md": [facts.map((row) => row.replace("- User: ", "- ")), 16] }, ["user likes", "likes tea", "green tea", "dog biscuit", "plays tennis"]);
  // S4 more than 8 words: the note's own words come last
  run("S4 long message", { "side0.md": [[dentist, ...chores], 16] }, ["alice bruno carla weekly kitchen rota chores then dentist onyx mill", "weekly kitchen rota chores for alice and bruno and also the dentist at onyx mill"]);
  // S5 gate R case 2 and case 3 as the user would ask
  const outN = "- Ferry ticket: outbound from Silver Pier on 2026-11-20 (noted 2026-10-14)", retN = "- Ferry ticket: return from Amber Quay on 2026-11-20 (noted 2026-10-15)", deck = "- Ferry ticket: car deck upgrade paid (noted 2026-10-16)";
  const TQ2 = ["silver pier", "amber quay", "ferry ticket", "ferry ticket return", "ferry ticket outbound", "car deck upgrade", "what ferry tickets do i have"];
  run("S5 case 2", { "connections.md": [[outN, retN], 15] }, TQ2);
  run("S5 case 2 + deck note (case 3)", { "connections.md": [[outN, retN, deck], 16] }, TQ2);
  run("S5 case 2, three files", { "connections.md": [[outN], 14], "travel.md": [[retN], 15], "auto-notes-overflow.md": [[retN], 15] }, TQ2);
}

function probeSeed(run: Run) {


  run("plan 1716",{"side0.md": [["- Ferry booking: provisional Cobalt Acme on 2026-11-25 (noted 2026-10-13)", "- Ferry booking: moved to Indigo Globex on 2026-11-20 (noted 2026-13-02)", "- Ferry booking: Coral Bend on 2026-11-20 (noted 2026-10-15)", "- Ferry booking: provisional Opal Gate (noted 2026-10-11)", "- Ferry booking: Coral Bend on 2026-11-20 (noted 2026-10-15)"], 19]},["ferry booking cobalt acme", "cobalt acme", "coral bend"]);

  run("plan 1869",{"side0.md": [["- Ferry ticket: Russet Tarn on 2026-11-25 (noted 2026-10-10)", "- Ferry ticket: Rust Ridge for 2026-11-20 (noted 2026-13-02)", "- Ferry ticket: Rust Ridge for 2026-11-20 (noted 2026-10-11)"], 19], "auto-notes-overflow.md": [["- Ferry ticket: moved to Umber Vale", "- Ferry ticket: Rust Ridge for 2026-11-20 (noted 2026-10-11)", "- Ferry ticket: Rust Ridge for 2026-11-20 (noted 2026-10-11)"], 18]},["ferry ticket russet tarn", "russet tarn", "rust ridge"]);
}

function probeT(run: Run) {
  const supplies = (n: number) => Array.from({ length: n }, (_, i) => "- Supply " + i + " crate" + i + " tent" + i);


  const queries = [
   "marble station", "오팔 역에서", "marble station before saffron relay", "오팔 역에서 주간 회의 전에",
   "marble station 주간 회의", "saffron relay", "saffron relay before marble station",
   "station meeting", "relay meeting", "relay", "meeting", "saffron", "주간 회의",
   "회의", "station relay", "before the relay meeting at marble station", "which relay uses marble station",
   "does the saffron relay meet at marble station", "saffron marble weekly 회의", "오팔 marble station 회의",
   "tandem relay", "violet crane", "meeting violet crane", "주간 relay", "marble meetings"
  ];
  for (const size of [1, 3, 50]) for (const filler of [0, 52]) for (const overlap of [false, true]) {
   const extra = supplies(filler);
   const rows = Array.from({length:size}, (_,i)=> "- Saffron relay 주간 회의: tandem meeting 주간 shift" + i);
   const note = "- Clinic: Marble Station 오팔 역에서" + (overlap ? " relay 회의" : "");
   const rare = "- Meeting: Violet Crane";
   run(['cross',size,filler,overlap].join('/'), {"roster.md":[rows,16],"clinic.md":[[...extra,note,rare],16]}, queries);
  }
  // Separate labels share the common word. Swap which list owns the single detailed value.
  for (const [a,b] of [[1,50],[50,1],[1,1],[50,50]]) for (const flip of [false,true]) {
   const group=(title:string,n:number,place:string)=>Array.from({length:n},(_,i)=>"- "+title+": relay 회의 "+(i===0 ? place : "rotation")+" slot"+i);
   const groupA=group("Relay meeting",a,"marble station");
   const groupB=group("주간 relay",b,"오팔 역에서");
   const notes=["- Meeting: Violet Crane"];
   run(['two',a,b,flip].join('/'), {"rota.md":[flip?[...groupB,...groupA,...notes]:[...groupA,...groupB,...notes],16]},queries);
  }
}

function probeU(run: Run) {

  const meeting = "- Volunteer rota: ";
  const q = ["volunteer rota before the harbor tour", "volunteer rota harbor tour", "is the volunteer rota before my harbor tour", "volunteer rota", "harbor tour", "same volunteer rota before the harbor tour", "rota harbor tour", "evening volunteer rota before the harbor tour"];
  for (const keep of [1,3,8,50]) for (const repeat of [1,3,8,50]) {
   const roster = Array.from({length:keep},(_,i)=>meeting+["evening pickup","bring spare keys","cover west desk","check pantry"][i%4]+" shift"+i);
   const port = "- Destination: Harbor";
   const tour = "- Activity: Tour";
   run("calendar/"+keep+"/"+repeat, {"roster.md":[roster,16], "plan.md":[Array(repeat).fill([port,tour]).flat(),16]},q);
  }
  const q2 = ["marble station before the weekly planning meeting","is my clinic at marble station before the weekly planning meeting","marble station weekly planning meeting","marble station","weekly planning meeting"];
  for (const keep of [1,2,3,5]) for (const repeat of [1,3,10,50]) {
   const copies=Array.from({length:keep},(_,i)=>"- Weekly planning meeting: "+["north room","south room","west room","desk","field"][i]);
   run("repeat/"+keep+"/"+repeat,{"clinic.md":[["- Clinic: Marble Station"],16],"rota.md":[Array(repeat).fill(copies).flat(),16]},q2);
  }
}

function probeV(run: Run) {
  const supplies = (n: number) => Array.from({ length: n }, (_, i) => "- Supply " + i + " crate" + i + " tent" + i);

  const dentist = "- Dentist: Onyx Mill on 2026-11-25 (noted 2026-10-11)";
  const days = ["Monday standup moved to ten", "Tuesday demo with Priya", "Wednesday budget review", "Thursday hiring sync", "Friday retro in room four", "roadmap check every month", "notes go to Farid", "skip on public holidays"];
  const meet = (k: number) => days.slice(0, k).map((row) => "- Weekly team meeting: " + row);
  const QV = ["onyx mill", "dentist onyx mill", "is onyx mill before the weekly team meeting", "is the dentist at onyx mill before the weekly team meeting", "dentist onyx mill weekly team meeting", "weekly team meeting", "weekly team meeting monday"];
  for (const k of [2, 3, 5, 8]) for (const n of [0, 30, 80]) run("V1 meeting rows " + k + " filler " + n, { "side0.md": [[...supplies(n), dentist, ...meet(k)], 16] }, QV);
  // the note and the list in two files
  for (const k of [5, 8]) run("V2 two files, meeting rows " + k, { "health.md": [[dentist], 16], "work.md": [meet(k), 16] }, QV);
  // V3 a one-word label: only that word repeats
  const trips = ["Lisbon in March", "Oslo in May", "Kyoto in October", "Lima next year", "Cairo with Sam", "Perth for the wedding"].map((row) => "- Trip: " + row);
  run("V3 one-word label x6", { "side0.md": [[dentist, ...trips], 16] }, ["dentist onyx mill trip", "is onyx mill before the trip", "is onyx mill before my trip to lisbon", "onyx mill lisbon trip", "trip lisbon"]);
}

function probeW(run: Run) {


  const sup = (n: number) => Array.from({ length: n }, (_, i) => "- Supply " + i + " crate" + i + " tent" + i);
  const ny = "- Lives in New York (noted 2026-10-15)", bos = "- Lives in Boston (noted 2026-10-15)";
  const tor = "- Home city: Toronto (noted 2026-10-15)", van = "- Home city: Vancouver (noted 2026-10-15)";
  for (const n of [0, 24, 60]) {
    run("W1 writer-pinned rows NY, Boston, NY same day, filler " + n, { "auto-notes-overflow.md": [[...sup(n), ny, bos, ny], 15] }, ["new york", "boston", "lives in new york", "where do i live"]);
    run("W2 Home city Toronto, Vancouver, Toronto same day, filler " + n, { "auto-notes-overflow.md": [[...sup(n), tor, van, tor], 15] }, ["toronto", "vancouver", "home city", "home city toronto"]);
    run("W3 control NY, Boston, filler " + n, { "auto-notes-overflow.md": [[...sup(n), ny, bos], 15] }, ["new york", "boston"]);
  }
}

function probeX(run: Run) {

  const q=["is the evening rota at the harbor for the tour", "evening rota harbor tour", "is evening pickup at the harbor for the tour","evening rota","harbor tour"];
  for (const n of [1,2,3]) for (const copies of [1,2,3]) for (const stamped of [false,true]) {
   const roster=["- Volunteer rota: evening pickup","- Volunteer rota: bring spare keys","- Volunteer rota: cover west desk"].slice(0,n);
   const plans=Array.from({length:copies},(_,i)=>["- Destination: Harbor","- Activity: Tour"].map(v=>v+(stamped?" on 2026-11-28 (noted 2026-10-"+(10+i)+")":""))).flat();
   run("min/"+n+"/"+copies+"/"+stamped,{"roster.md":[roster,16],"plan.md":[plans,16]},q);
  }
}

/** Each probe's layouts, its files written on October days and listed by name, as recall lists them. */
export function gateProbes(): RecallCase[] {
  const cases: RecallCase[] = [];
  const probes = { "1": probe1, "2": probe2, "L": probeL, "N": probeN, "Proof": probeProof, "S": probeS, "Seed": probeSeed, "T": probeT, "U": probeU, "V": probeV, "W": probeW, "X": probeX };
  for (const [family, probe] of Object.entries(probes)) {
    probe((name, files, messages) => {
      const listed = Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
      cases.push({ family: `probe ${family}`, name, files: listed.map(([file, [rows, day]]) => ({ source: `memory/${file}`, tier: 0, text: `# Notes\n${rows.join("\n")}\n`, mtime: new Date(2026, 9, day, 12).getTime() })), messages: [...messages] });
    });
  }
  return cases;
}

const tierOf = (source: string): 0 | 1 => (source === "notes.md" ? 1 : 0);

/** The gates' seeded plans: profile q from gate Q, r from gate R, s from gates S and T. */
export function gatePlans(seed: number, plans: number, profile: "q" | "r" | "s"): RecallCase[] {
  const cases: RecallCase[] = [];
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (n: number) => Math.floor(rand() * n);
  const of = <T,>(list: readonly T[]) => list[pick(list.length)]!;
  const labels = profile === "r" || profile === "s" ? ["Ferry ticket", "Ferry booking", "Dentist"] : ["Ferry booking", "Station assignment", "Research station", "Dentist", "Standup", "Field booking"];
  const places = ["Silver Pier", "Amber Quay", "Cobalt Acme", "Indigo Globex", "Cedar Dock", "Harbor Road", "Maple Yard", "Opal Gate", "Jade Wharf", "Rust Ridge", "Ivory Bluff", "Onyx Mill", "Pearl Cove", "Slate Hollow", "Coral Bend", "Umber Vale", "Lilac Moor", "Russet Tarn"];
  const two = (n: number) => String(n).padStart(2, "0");
  const value = (text: string) => text.replace(/^[-*]\s+/, "").replace(/\s*\(noted [^)]*\)$/, "");
  const validDay = (day: string) => Boolean(day) && new Date(day + "T00:00:00Z").toJSON()?.startsWith(day) === true;
  const noted = (text: string) => {
    const day = /\(noted (\d{4}-\d{2}-\d{2})\)$/.exec(text.trim().replace(/[\s|]+$/, ""))?.[1] ?? "";
    return validDay(day) ? day : "";
  };
  const labelOf = (row: string) => {
    const text = row.replace(/^[\s|]+|[\s|]+$/g, "");
    const table = row.trim().startsWith("|");
    const cell = table ? text.split("|")[0]!.trim() : (/^(?:[-*]\s+)?([^:]{2,60}):\s/.exec(text)?.[1] ?? "");
    return cell.toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(" ") ?? "";
  };
  const placeOf = (row: string) => places.find((place) => row.includes(place))!;
  for (let plan = 0; plan < plans; plan++) {
    const own = [of(labels), of(labels), of(labels)].slice(0, 1 + pick(3));
    const free = [...places].sort(() => rand() - 0.5);
    const table = pick(10) === 0;
    const rows: string[] = [];
    for (let n = 2 + pick(6); n > 0 && free.length; n--) {
      const stamp = () => {
        const roll = pick(20);
        if (profile === "r" || profile === "s") return roll < 5 ? "" : roll < 19 ? " (noted 2026-10-" + two(10 + pick(7)) + ")" : of([" (noted 2026-13-02)", " (noted 2926-10-02)"]);
        if (roll < 7) return "";
        if (roll < 17) return " (noted 2026-10-" + two(8 + pick(13)) + ")";
        if (roll === 17) return of([" (noted 2026-13-02)", " (noted 2026-02-30)", " (noted 2026-10-32)", " (noted 2026-00-10)"]);
        if (roll === 18) return " (noted 2026-10-" + two(8 + pick(13)) + ") updated";
        return " (noted 2026-12-01)";
      };
      const copy = rows.length && pick(4) === 0 ? of(rows) : undefined;
      if (copy) rows.push(pick(2) ? copy : value(copy).replace(/^/, table ? "" : "- ") + stamp() + (table ? " |" : ""));
      else {
        const words = profile === "r" || profile === "s"
          ? of(["", "", " on 2026-11-20", " for 2026-11-20", " on 2026-11-20", " on 2026-11-25", " from 2026-10-12", " until 12-05"])
          : of(["", "", "", " from 2026-10-" + two(1 + pick(28)), " on 2026-11-" + two(1 + pick(28)), " until 12-05", " since 09-14", " on 2027-01-15"]);
        const verb = of(["", "confirmed ", "moved to ", "provisional "]);
        const body = verb + free.pop() + words;
        const label = of(own);
        rows.push(table ? "| " + label + " | " + body + stamp() + " |" : "- " + label + ": " + body + stamp());
      }
    }
    if (profile === "s") {
      const label = labelOf(table ? rows[0]! : rows[0]!);
      const mine = rows.filter((row) => labelOf(row) === label && noted(row));
      const newest = mine.sort((a, b) => (noted(a) < noted(b) ? 1 : -1))[0];
      if (newest) for (let n = 1 + pick(2); n > 0; n--) {
        const kind = pick(4);
        const plain = newest.replace(/\s*\(noted [^)]*\)(\s*\|)?\s*$/, table ? " |" : "");
        rows.push(kind === 0 ? newest : kind === 1 ? plain : kind === 2 ? (table ? newest.replace(/\s*\|\s*$/, " updated |") : newest + " updated") : newest);
      }
    }
    const fixRow = (row: string) => (table && !row.startsWith("|") ? "| " + row : row);
    const count = profile === "s" ? of([0, 0, 4, 8, 16, 24, 40, 45, 48, 52, 60]) : of([0, 0, 8, 24, 45, 48, 52, 128]);
    const supplies = Array.from({ length: count }, (_, n) => "- Supply " + n + " crate" + n + " tent" + n);
    const split = profile === "s" ? 1 + pick(3) : 1 + (pick(3) === 0 ? 1 + pick(2) : 0);
    const names = ["memory/side0.md", "memory/auto-notes-overflow.md", "notes.md"];
    const files = Array.from({ length: split }, (_, at) => ({
      source: names[at]!,
      tier: tierOf(names[at]!),
      text: "# Notes\n" + [...(at ? [] : supplies), ...rows.filter((_, n) => n % split === at).map(fixRow)].join("\n") + "\n",
      mtime: new Date(2026, 9, 10 + pick(13), 12).getTime(),
    }));
    const kept = rows.map(fixRow);
    const queries = [...new Set([...kept.map((row) => placeOf(row).toLowerCase()), ...own.map((name) => name.toLowerCase()), ...kept.map((row) => labelOf(row) + " " + placeOf(row).toLowerCase())])];
    if (profile === "s" && kept.length > 1) {
      const [a, b] = [of(kept), of(kept)];
      queries.push(...new Set([labelOf(a) + " " + placeOf(a).toLowerCase() + " " + labelOf(b), placeOf(a).toLowerCase() + " " + placeOf(b).toLowerCase(), "is the " + labelOf(a) + " at " + placeOf(a).toLowerCase() + " still on"].filter((query) => !queries.includes(query))));
    }
    cases.push({ family: `plans ${profile} ${seed}`, name: `plan ${plan}`, files, messages: queries });
  }
  return cases;
}

/** The files each build reads: 83f790c87 skips a file past the 2 MB budget; this build reads its whole lines within the room left, with no modified day. */
export function asRead(files: NoteFile[]): [before: NoteFile[], now: NoteFile[]] {
  const [before, past]: [NoteFile[], NoteFile[]] = [[], []];
  let bytes = 0;
  for (const file of files) {
    const size = Buffer.byteLength(file.text);
    if (bytes + size > MAX_CORPUS_BYTES) past.push(file);
    else {
      bytes += size;
      before.push(file);
    }
  }
  const now = [...before];
  for (const file of past) {
    const start = Buffer.from(file.text).subarray(0, Math.max(0, MAX_CORPUS_BYTES - bytes));
    const text = start.subarray(0, start.lastIndexOf(10) + 1).toString("utf8");
    if (!text) continue;
    bytes += Buffer.byteLength(text);
    now.push({ ...file, text, mtime: 0 });
  }
  return [before, now];
}
