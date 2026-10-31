import { z } from "zod";

/** One person heard in the voice channel, resolved to their Foundry identity. */
export const ParticipantSchema = z.object({
  discordId: z.string(),
  displayName: z.string(),
  character: z.string().nullable(),
  actorId: z.string().nullable(),
  isGm: z.boolean(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

/** One speech burst from one speaker. Times are ms relative to session start. */
export const SegmentSchema = z.object({
  discordId: z.string(),
  startMs: z.number(),
  endMs: z.number(),
  file: z.string(),
});
export type Segment = z.infer<typeof SegmentSchema>;

/** data/sessions/<id>/timeline.json — written by the recorder, read by the worker. */
export const TimelineSchema = z.object({
  sessionId: z.string(),
  guildId: z.string(),
  channelId: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  sampleRate: z.number(),
  channels: z.number(),
  participants: z.array(ParticipantSchema),
  segments: z.array(SegmentSchema),
});
export type Timeline = z.infer<typeof TimelineSchema>;

/** One transcribed line. Times are seconds relative to session start. */
export const TranscriptLineSchema = z.object({
  t: z.number(),
  end: z.number(),
  discordId: z.string(),
  speaker: z.string(),
  character: z.string().nullable(),
  isGm: z.boolean(),
  text: z.string(),
});
export type TranscriptLine = z.infer<typeof TranscriptLineSchema>;

/** data/sessions/<id>/transcript.json — written by the worker. */
export const TranscriptSchema = z.object({
  sessionId: z.string(),
  model: z.string(),
  language: z.string().nullable(),
  createdAt: z.string(),
  lines: z.array(TranscriptLineSchema),
});
export type Transcript = z.infer<typeof TranscriptSchema>;

/** data/sessions/<id>/chatlog.json — exported by the Foundry module. */
export const ChatMessageSchema = z.object({
  id: z.string(),
  timestamp: z.number(), // epoch ms
  alias: z.string().nullable().default(null),
  actorId: z.string().nullable().default(null),
  userName: z.string().nullable().default(null),
  inCharacter: z.boolean().default(false),
  isRoll: z.boolean().default(false),
  whisper: z.boolean().default(false),
  flavor: z.string().nullable().default(null),
  content: z.string().default(""),
  rolls: z
    .array(z.object({ formula: z.string(), total: z.number().nullable(), flavor: z.string().nullable().default(null) }))
    .default([]),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const CombatSchema = z.object({
  id: z.string(),
  name: z.string().nullable().default(null),
  scene: z.string().nullable().default(null),
  round: z.number().default(0),
  startedAt: z.number().nullable().default(null),
  endedAt: z.number().nullable().default(null),
  combatants: z
    .array(
      z.object({
        name: z.string(),
        actorId: z.string().nullable().default(null),
        isNPC: z.boolean().default(false),
        defeated: z.boolean().default(false),
        hidden: z.boolean().default(false),
      }),
    )
    .default([]),
});
export type Combat = z.infer<typeof CombatSchema>;

export const ChatLogSchema = z.object({
  world: z.string().nullable().default(null),
  exportedAt: z.number().optional(),
  messages: z.array(ChatMessageSchema).default([]),
  combats: z.array(CombatSchema).default([]),
});
export type ChatLog = z.infer<typeof ChatLogSchema>;

/** Roster pushed from Foundry: each user and their assigned character. */
export const RosterPayloadSchema = z.object({
  world: z.string().nullable().default(null),
  users: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      isGM: z.boolean().default(false),
      discordId: z.string().nullable().default(null),
      character: z
        .object({ id: z.string(), name: z.string(), img: z.string().nullable().default(null) })
        .nullable()
        .default(null),
    }),
  ),
  actors: z
    .array(z.object({ id: z.string(), name: z.string(), type: z.string().nullable().default(null) }))
    .default([]),
});
export type RosterPayload = z.infer<typeof RosterPayloadSchema>;
