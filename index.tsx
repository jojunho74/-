import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
// Fix: Removed `LiveSession` as it is not an exported member of `@google/genai`.
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';

// --- Helper Functions for Audio Processing ---

// Decodes base64 string to Uint8Array
function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Encodes Uint8Array to base64 string
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// Decodes raw PCM audio data into an AudioBuffer for playback
async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

// Fix: Define the type for the live session promise since `LiveSession` is not exported.
type LiveSessionPromise = ReturnType<InstanceType<typeof GoogleGenAI>["live"]["connect"]>;

// --- React Component ---

interface Transcript {
  speaker: 'user' | 'ai';
  text: string;
}

const GemAvatar: React.FC<{ className?: string }> = ({ className }) => (
    <svg className={className} width="40" height="40" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="50" fill="url(#avatar-gradient)"/>
      <path d="M50 62C65 62 75 72 75 72C75 72 65 82 50 82C35 82 25 72 25 72C25 72 35 62 50 62Z" fill="#FFF" fillOpacity="0.8"/>
      <circle cx="38" cy="48" r="6" fill="#FFF"/>
      <circle cx="62" cy="48" r="6" fill="#FFF"/>
      <path d="M38 50C40.2091 50 42 48.2091 42 46C42 43.7909 40.2091 42 38 42C35.7909 42 34 43.7909 34 46C34 48.2091 35.7909 50 38 50Z" fill="#333"/>
      <path d="M62 50C64.2091 50 66 48.2091 66 46C66 43.7909 64.2091 42 62 42C59.7909 42 58 43.7909 58 46C58 48.2091 59.7909 50 62 50Z" fill="#333"/>
      <defs>
        <linearGradient id="avatar-gradient" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
          <stop stopColor="#89f7fe"/>
          <stop offset="1" stopColor="#66a6ff"/>
        </linearGradient>
      </defs>
    </svg>
);

// Renders AI message, parsing for and styling feedback
const renderMessageWithFeedback = (text: string) => {
    const feedbackRegex = /<feedback>(.*?)<\/feedback>/s;
    const match = text.match(feedbackRegex);

    if (!match) {
        return text;
    }

    const feedbackContent = match[1];
    // Split the text by the full feedback tag, including the tags themselves
    const parts = text.split(feedbackRegex);
    const beforeText = parts[0];
    const afterText = parts[2] || ''; // Ensure afterText is a string

    return (
        <>
            {beforeText}
            <div className="feedback-box">
                <div className="feedback-header">💡 Suggestion</div>
                <div className="feedback-content">{feedbackContent}</div>
            </div>
            {afterText}
        </>
    );
};


const App: React.FC = () => {
  const [status, setStatus] = useState('Press the mic to start');
  const [isRecording, setIsRecording] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [currentInput, setCurrentInput] = useState('');
  const [currentOutput, setCurrentOutput] = useState('');
  
  const transcriptContainerRef = useRef<HTMLDivElement>(null);
  const sessionPromiseRef = useRef<LiveSessionPromise | null>(null);
  const audioContextRefs = useRef<{ input: AudioContext | null, output: AudioContext | null, stream: MediaStream | null, processor: ScriptProcessorNode | null }>({ input: null, output: null, stream: null, processor: null });
  const audioPlayback = useRef<{ nextStartTime: number, sources: Set<AudioBufferSourceNode> }>({ nextStartTime: 0, sources: new Set() });

  useEffect(() => {
    // Scroll to the bottom of the transcript
    if (transcriptContainerRef.current) {
      transcriptContainerRef.current.scrollTop = transcriptContainerRef.current.scrollHeight;
    }
  }, [transcripts, currentInput, currentOutput]);

  const stopConversation = () => {
    setIsRecording(false);
    setStatus('Press the mic to start');

    if (sessionPromiseRef.current) {
      sessionPromiseRef.current.then(session => session.close());
      sessionPromiseRef.current = null;
    }

    audioContextRefs.current.stream?.getTracks().forEach(track => track.stop());
    audioContextRefs.current.processor?.disconnect();
    audioContextRefs.current.input?.close();
    audioContextRefs.current.output?.close();
    audioContextRefs.current = { input: null, output: null, stream: null, processor: null };

    audioPlayback.current.sources.forEach(source => source.stop());
    audioPlayback.current.sources.clear();
    audioPlayback.current.nextStartTime = 0;
  };

  const startConversation = async () => {
    setIsConnecting(true);
    setStatus('Connecting...');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContextRefs.current.stream = stream;

      const inputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputAudioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextRefs.current.input = inputAudioContext;
      audioContextRefs.current.output = outputAudioContext;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY as string });
      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'Kore'}},
          },
          systemInstruction: `You are Gem, a super friendly and encouraging 12-year-old English tutor. Your mission is to help your friend (the user) practice speaking English in a fun, casual way.
          Here's how you should chat:
          1. Always be positive and cheerful! After the user says something, start your response with positive feedback like 'Awesome!', 'That sounded great!', or 'You're doing so well!'.
          2. After the positive feedback, if you notice a mistake or a way they could sound more natural, gently suggest a correction. Frame it as a friendly tip.
          3. CRITICAL: When you give this feedback, you MUST wrap your suggestion in <feedback> tags. For example: 'That's a great start! <feedback>Just a tiny tip, we usually say 'I went to the store' instead of 'I go to the store yesterday'.</feedback> Keep up the amazing work! So, what did you buy?'. Another example: 'Wow, great pronunciation! <feedback>A slightly more native way to say that would be 'I'm really looking forward to it'.</feedback> But what you said was perfectly clear! So, what are you looking forward to?'
          4. After giving feedback, continue the conversation naturally by asking a question or adding to what they said.
          5. Keep your own speaking style fun, clear, and like a 12-year-old.
          6. Respond only in English.
          7. Start the very first conversation by saying 'Hey! I'm Gem! It's so cool to meet you. Let's chat! What's on your mind today?'`,
        },
        callbacks: {
          onopen: () => {
            setIsConnecting(false);
            setIsRecording(true);
            setStatus('Listening...');

            const source = inputAudioContext.createMediaStreamSource(stream);
            const processor = inputAudioContext.createScriptProcessor(4096, 1, 1);
            audioContextRefs.current.processor = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob: Blob = {
                data: encode(new Uint8Array(new Int16Array(inputData.map(f => f * 32768)).buffer)),
                mimeType: 'audio/pcm;rate=16000',
              };
              if (sessionPromiseRef.current) {
                sessionPromiseRef.current.then(session => session.sendRealtimeInput({ media: pcmBlob }));
              }
            };

            source.connect(processor);
            processor.connect(inputAudioContext.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
             if (message.serverContent?.inputTranscription) {
                setCurrentInput(prev => prev + message.serverContent!.inputTranscription!.text);
             }
             if (message.serverContent?.outputTranscription) {
                setCurrentOutput(prev => prev + message.serverContent!.outputTranscription!.text);
             }
             if (message.serverContent?.turnComplete) {
                const finalInput = currentInput + (message.serverContent?.inputTranscription?.text || '');
                const finalOutput = currentOutput + (message.serverContent?.outputTranscription?.text || '');
                setTranscripts(prev => [
                    ...prev,
                    { speaker: 'user', text: finalInput },
                    { speaker: 'ai', text: finalOutput },
                ]);
                setCurrentInput('');
                setCurrentOutput('');
             }

            const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audioData) {
              setStatus("Gem is speaking...");
              const audioBuffer = await decodeAudioData(decode(audioData), outputAudioContext, 24000, 1);
              const source = outputAudioContext.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(outputAudioContext.destination);

              const now = outputAudioContext.currentTime;
              const startTime = Math.max(now, audioPlayback.current.nextStartTime);
              source.start(startTime);
              audioPlayback.current.nextStartTime = startTime + audioBuffer.duration;
              audioPlayback.current.sources.add(source);
              source.onended = () => {
                audioPlayback.current.sources.delete(source);
                if (audioPlayback.current.sources.size === 0) {
                    setStatus('Listening...');
                }
              };
            }
          },
          onerror: (e: ErrorEvent) => {
            console.error(e);
            setStatus('An error occurred. Please try again.');
            stopConversation();
          },
          onclose: () => {
            console.log('Connection closed.');
            // Don't call stopConversation() here to avoid potential race conditions on cleanup
          }
        }
      });
    } catch (error) {
      console.error("Failed to start conversation:", error);
      setStatus('Could not start. Check microphone permissions.');
      setIsConnecting(false);
    }
  };

  const toggleConversation = () => {
    if (isRecording) {
      stopConversation();
    } else {
      startConversation();
    }
  };

  return (
    <div className="app-container">
      <header className="header">
        <h1>English Practice with Gem</h1>
      </header>
      <div className="transcript-container" ref={transcriptContainerRef}>
        {transcripts.length === 0 && !isConnecting && !isRecording && (
            <div className="welcome-container">
                <GemAvatar className="avatar-large" />
                <h2>Hi, I'm Gem!</h2>
                <p>Ready to practice your English? Press the microphone button to start!</p>
            </div>
        )}
        {transcripts.map((t, index) => (
            <div key={index} className={`transcript-entry ${t.speaker}`}>
                {t.speaker === 'ai' && <GemAvatar className="avatar-small" />}
                <div className="message-bubble">
                    <strong>{t.speaker === 'user' ? 'You' : 'Gem'}:</strong>
                    {t.speaker === 'ai' ? renderMessageWithFeedback(t.text) : t.text}
                </div>
            </div>
        ))}
         {currentInput && (
            <div className="transcript-entry user">
                 <div className="message-bubble">
                    <strong>You:</strong>
                    {currentInput}
                </div>
            </div>
         )}
         {currentOutput && (
            <div className="transcript-entry ai">
                <GemAvatar className="avatar-small" />
                <div className="message-bubble">
                    <strong>Gem:</strong>
                    {renderMessageWithFeedback(currentOutput)}
                </div>
            </div>
         )}
      </div>
      <div className="controls">
        <div className="status-text">{status}</div>
        <button
          className={`mic-button ${isRecording ? 'recording' : ''}`}
          onClick={toggleConversation}
          disabled={isConnecting}
          aria-label={isRecording ? 'Stop conversation' : 'Start conversation'}
        >
          {isRecording ? (
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h12v12H6z"/></svg>
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 2.99-1.34 2.99-3L15 5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.48 6-3.3 6-6.72h-1.7z"/></svg>
          )}
        </button>
      </div>
    </div>
  );
};

const container = document.getElementById('root');
const root = createRoot(container!);
root.render(<App />);