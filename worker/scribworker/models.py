"""File contracts shared with the bot (see bot/src/types.ts)."""

from __future__ import annotations

from pydantic import BaseModel


class Participant(BaseModel):
    discordId: str
    displayName: str
    character: str | None = None
    actorId: str | None = None
    isGm: bool = False


class Segment(BaseModel):
    discordId: str
    startMs: float
    endMs: float
    file: str


class Timeline(BaseModel):
    sessionId: str
    guildId: str
    channelId: str
    startedAt: str
    endedAt: str | None = None
    sampleRate: int
    channels: int
    participants: list[Participant]
    segments: list[Segment]


class TranscriptLine(BaseModel):
    t: float
    end: float
    discordId: str
    speaker: str
    character: str | None
    isGm: bool
    text: str


class Transcript(BaseModel):
    sessionId: str
    model: str
    language: str | None
    createdAt: str
    lines: list[TranscriptLine]
