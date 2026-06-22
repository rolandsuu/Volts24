import React from "react";
import { Composition } from "remotion";

import {
  InstructionVideo,
  type InstructionVideoProps,
} from "./instruction-video";

const defaultProps: InstructionVideoProps = {
  videoSrc: "",
  voiceoverSrc: "",
  width: 1080,
  height: 1920,
  fps: 30,
  durationInFrames: 300,
  overlayCues: [],
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="InstructionVideo"
      component={InstructionVideo}
      defaultProps={defaultProps}
      width={defaultProps.width}
      height={defaultProps.height}
      fps={defaultProps.fps}
      durationInFrames={defaultProps.durationInFrames}
      calculateMetadata={({ props }) => {
        return {
          width: props.width,
          height: props.height,
          fps: props.fps,
          durationInFrames: props.durationInFrames,
        };
      }}
    />
  );
};
