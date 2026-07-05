import 'dotenv/config';
import { getDb } from '../src/db';
import { unpackVector } from '../src/memory/embeddings';

const db = getDb();
const n = (q: string) => (db.prepare(q).get() as { n: number }).n;

console.log('total:', n('select count(*) n from memory_index'));
console.log('embedded:', n("select count(*) n from memory_index where embedding is not null"));
console.log('models:', JSON.stringify(db.prepare('select embedding_model, count(*) n from memory_index group by embedding_model order by n desc').all()));
console.log('types:', JSON.stringify(db.prepare('select type, count(*) n from memory_index group by type order by n desc').all()));
console.log('entities:', n('select count(*) n from memory_entities'), '| relationships:', n('select count(*) n from memory_relationships'));

const row = db.prepare("select embedding from memory_index where embedding is not null limit 1").get() as { embedding: Buffer } | undefined;
const vec = unpackVector(row?.embedding);
console.log('sample vector dim:', vec?.length);

// extra: max title/summary length (sizing), tags shape sanity
const sizes = db.prepare("select max(length(title)) t, max(length(summary)) s, max(length(tags)) g from memory_index").get() as { t: number; s: number; g: number };
console.log('max lengths → title:', sizes.t, '| summary:', sizes.s, '| tags:', sizes.g);
const sampleTags = db.prepare("select tags from memory_index where tags is not null and tags != '' limit 1").get() as { tags: string } | undefined;
console.log('sample tags:', sampleTags?.tags ?? '(none)');
