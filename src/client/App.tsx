import { useState } from "react";
import { Lobby } from "./room/Lobby";
import { MeetingRoom } from "./room/MeetingRoom";
import type { RoomSocketAuth } from "./room/room-socket";
import { useRoom } from "./room/use-room";

export function App() {
  const room = useRoom();
  const [activeRoom, setActiveRoom] = useState<RoomSocketAuth | null>(null);

  const join = async (input: RoomSocketAuth) => {
    setActiveRoom(input);
    try {
      await room.join(input);
    } catch (error) {
      setActiveRoom(null);
      throw error;
    }
  };

  const leave = () => {
    void room.leave();
    setActiveRoom(null);
  };

  if (!activeRoom) return <Lobby onJoin={join} />;

  return (
    <MeetingRoom
      roomId={activeRoom.roomId}
      secret={activeRoom.secret}
      participants={room.participants}
      selfParticipantId={room.selfParticipantId}
      status={room.status}
      muted={room.muted}
      error={room.error}
      transcriptFinals={room.transcriptFinals}
      transcriptPartials={room.transcriptPartials}
      remoteAudioRef={room.remoteAudioRef}
      onToggleMute={room.toggleMute}
      onLeave={leave}
    />
  );
}
