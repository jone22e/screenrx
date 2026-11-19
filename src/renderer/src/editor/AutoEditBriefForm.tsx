import { useState } from "react";
import { WORKER_SPECS } from "@engine/ai/workerPrompts";
import { PLATFORM_PRESETS } from "@engine/export/platformPresets";
import { formatTimecode } from "@shared/format";
import type { AutoEditBrief, WorkerRole } from "@shared/models/autoEdit";
import { WORKER_ROLES } from "@shared/models/autoEdit";

interface Props {
  brief: AutoEditBrief;
  onChange: (brief: AutoEditBrief) => void;
  /** The recording's length, shown beside the target; left out for a series, whose episodes differ. */
  durationMs?: number;
  disabled?: boolean;
  /** The name of the video on the second track, when there is one: the user says what each video is. */
  secondVideo?: string | null;
}

/** What the two videos usually are, until the user says otherwise. */
export const DEFAULT_VIDEO_ROLES = { first: "a gameplay", second: "minha reação (webcam)" };

export const ROLE_HINTS: Record<WorkerRole, string> = {
  cutter: "cortes e velocidade",
  camera: "zoom, formato e enquadramento",
  captioner: "legendas e títulos",
  sound: "volumes e música",
  art: "fundo e exportação",
};

/** A brief with everything on: for Reels, as long as it needs, the whole team. */
export const defaultBrief = (
  preset: AutoEditBrief["preset"] = "reels",
): AutoEditBrief => ({
  preset,
  targetDurationSec: null,
  tone: "",
  roles: [...WORKER_ROLES],
});

/**
 * What the team is asked for: where the video goes, how long it should be,
 * the feel, and which agents work. The same form in the editor's panel and
 * for a whole series in the library.
 */
export function AutoEditBriefForm({
  brief,
  onChange,
  durationMs,
  disabled = false,
  secondVideo = null,
}: Props) {
  const videoRoles = brief.videoRoles ?? DEFAULT_VIDEO_ROLES;
  const setRole = (key: "first" | "second", value: string): void =>
    onChange({ ...brief, videoRoles: { ...videoRoles, [key]: value } });
  const toggleRole = (role: WorkerRole): void =>
    onChange({
      ...brief,
      roles: brief.roles.includes(role)
        ? brief.roles.filter((entry) => entry !== role)
        : [...brief.roles, role],
    });
  // The tone and the team are for who wants them: folded away unless something there was changed.
  const [more, setMore] = useState(
    brief.tone !== "" || brief.roles.length !== WORKER_ROLES.length,
  );

  return (
    <>
      <label className="field">
        <span className="field-label">Para onde vai</span>
        <select
          className="select"
          value={brief.preset}
          disabled={disabled}
          onChange={(event) =>
            onChange({
              ...brief,
              preset: event.target.value as AutoEditBrief["preset"],
            })
          }
        >
          {PLATFORM_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Sem rede específica</option>
        </select>
      </label>
      {secondVideo !== null && (
        <div className="field video-roles">
          <span className="field-label">O que é cada vídeo</span>
          <label className="video-role">
            <span>Vídeo 1</span>
            <input
              className="text-input"
              type="text"
              value={videoRoles.first}
              maxLength={80}
              disabled={disabled}
              placeholder="a gameplay"
              onChange={(event) => setRole("first", event.target.value)}
            />
          </label>
          <label className="video-role" title={secondVideo}>
            <span>Vídeo 2</span>
            <input
              className="text-input"
              type="text"
              value={videoRoles.second}
              maxLength={80}
              disabled={disabled}
              placeholder="minha reação"
              onChange={(event) => setRole("second", event.target.value)}
            />
          </label>
        </div>
      )}
      <div className="field">
        <span className="field-label">
          Duração alvo{" "}
          {durationMs !== undefined && (
            <span className="agent-notes">
              · a gravação tem {formatTimecode(durationMs)}
            </span>
          )}
        </span>
        <div className="chips" role="radiogroup" aria-label="Duração alvo">
          {[null, 30, 60, 180].map((seconds) => (
            <button
              key={String(seconds)}
              className="chip chip-small"
              role="radio"
              aria-checked={brief.targetDurationSec === seconds}
              disabled={disabled}
              onClick={() => onChange({ ...brief, targetDurationSec: seconds })}
            >
              {seconds === null
                ? "Livre"
                : seconds < 60
                  ? `${seconds} s`
                  : `${seconds / 60} min`}
            </button>
          ))}
        </div>
      </div>
      <button
        className="field-link brief-more"
        aria-expanded={more}
        onClick={() => setMore((current) => !current)}
      >
        {more ? "Menos opções" : "Mais opções"}
      </button>
      {more && (
        <>
          <label className="field">
            <span className="field-label">Tom</span>
            <input
              className="text-input"
              aria-label="Tom do vídeo"
              placeholder="tutorial direto, bastidores, anúncio…"
              maxLength={200}
              disabled={disabled}
              value={brief.tone}
              onChange={(event) =>
                onChange({ ...brief, tone: event.target.value })
              }
              onKeyDown={(event) => event.stopPropagation()}
            />
          </label>
          <div className="field">
            <span className="field-label">Equipe</span>
            <div className="team-roles" role="group" aria-label="Agentes">
              {WORKER_ROLES.map((role) => (
                <button
                  key={role}
                  className="team-role"
                  aria-pressed={brief.roles.includes(role)}
                  title={ROLE_HINTS[role]}
                  disabled={disabled}
                  onClick={() => toggleRole(role)}
                >
                  <span
                    className="agent-dot"
                    style={{ background: WORKER_SPECS[role].color }}
                  />
                  {WORKER_SPECS[role].label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}
