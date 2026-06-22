import React from "react";
import {
  AbsoluteFill,
  Html5Audio,
  OffthreadVideo,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

export type RemotionInstructionOverlayCue = {
  segmentIndex: number;
  text: string;
  startSeconds: number;
  endSeconds: number;
};

export type InstructionVideoProps = {
  videoSrc: string;
  voiceoverSrc: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
  overlayCues: RemotionInstructionOverlayCue[];
};

const CAPTION_FADE_FRAMES = 6;

function toFrame(seconds: number, fps: number) {
  return Math.round(seconds * fps);
}

function getCueOpacity(options: {
  frame: number;
  fps: number;
  cue: RemotionInstructionOverlayCue;
}) {
  const startFrame = toFrame(options.cue.startSeconds, options.fps);
  const endFrame = toFrame(options.cue.endSeconds, options.fps);

  if (options.frame < startFrame || options.frame > endFrame) {
    return 0;
  }

  const fadeInProgress =
    (options.frame - startFrame + 1) / CAPTION_FADE_FRAMES;
  const fadeOutProgress =
    (endFrame - options.frame + 1) / CAPTION_FADE_FRAMES;

  return Math.max(0, Math.min(1, fadeInProgress, fadeOutProgress));
}

export const InstructionVideo: React.FC<InstructionVideoProps> = ({
  videoSrc,
  voiceoverSrc,
  width,
  height,
  overlayCues,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const activeCue = overlayCues.find((cue) => {
    const startFrame = toFrame(cue.startSeconds, fps);
    const endFrame = toFrame(cue.endSeconds, fps);

    return frame >= startFrame && frame <= endFrame;
  });
  const cueOpacity = activeCue
    ? getCueOpacity({ frame, fps, cue: activeCue })
    : 0;
  const fontSize = Math.max(28, Math.round(Math.min(width / 21, height / 30)));
  const horizontalMargin = Math.max(36, Math.round(width * 0.075));
  const bottomMargin = Math.max(44, Math.round(height * 0.072));

  return (
    <AbsoluteFill style={{ backgroundColor: "#000000" }}>
      <OffthreadVideo
        src={videoSrc}
        muted
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          backgroundColor: "#000000",
        }}
      />
      <Html5Audio src={voiceoverSrc} />
      {activeCue ? (
        <div
          style={{
            position: "absolute",
            left: horizontalMargin,
            right: horizontalMargin,
            bottom: bottomMargin,
            display: "flex",
            justifyContent: "center",
            opacity: cueOpacity,
          }}
        >
          <div
            style={{
              maxWidth: Math.round(width * 0.86),
              backgroundColor: "rgba(0, 0, 0, 0.74)",
              color: "#ffffff",
              borderRadius: 8,
              padding: `${Math.max(14, Math.round(fontSize * 0.34))}px ${Math.max(
                22,
                Math.round(fontSize * 0.5)
              )}px`,
              fontFamily:
                'Inter, "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif',
              fontSize,
              fontWeight: 700,
              lineHeight: 1.18,
              textAlign: "center",
              overflow: "hidden",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              wordBreak: "break-word",
              boxShadow: "0 12px 36px rgba(0, 0, 0, 0.32)",
            }}
          >
            {activeCue.text}
          </div>
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
