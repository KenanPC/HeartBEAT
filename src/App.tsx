import React, { useState, useEffect, useRef } from 'react';
import { Heart, Activity, Bluetooth, BluetoothOff, AlertCircle, Music, Plus, Trash2, Settings, CheckCircle2, Volume2, Play, Pause, SkipBack, SkipForward } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface Zone {
  id: string;
  min: number;
  max: number;
  playlistUri: string | null;
  playlistName: string | null;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  uri: string;
  images: { url: string }[];
}

export default function App() {
  // BLE State
  const [heartRate, setHeartRate] = useState<number | null>(null);
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const deviceRef = useRef<any>(null);

  // Spotify State
  const [spotifyUser, setSpotifyUser] = useState<any>(null);
  const [playlists, setPlaylists] = useState<SpotifyPlaylist[]>([]);
  const [spotifyError, setSpotifyError] = useState<string>('');
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [webPlayerDeviceId, setWebPlayerDeviceId] = useState<string | null>(null);
  const [playerStatus, setPlayerStatus] = useState<string>('Initializing...');
  const [volume, setVolume] = useState<number>(50);
  const [isPaused, setIsPaused] = useState<boolean>(true);
  const [currentTrack, setCurrentTrack] = useState<any>(null);
  const playerRef = useRef<any>(null);
  
  // Zone State
  const [zones, setZones] = useState<Zone[]>([
    { id: '1', min: 0, max: 100, playlistUri: null, playlistName: null },
    { id: '2', min: 101, max: 130, playlistUri: null, playlistName: null },
    { id: '3', min: 131, max: 160, playlistUri: null, playlistName: null },
    { id: '4', min: 161, max: 200, playlistUri: null, playlistName: null },
  ]);
  const [currentZoneId, setCurrentZoneId] = useState<string | null>(null);
  const zoneTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // --- BLE LOGIC ---

  const connectToWhoop = async () => {
    try {
      setStatus('connecting');
      setErrorMsg('');

      const nav = navigator as any;
      if (!nav.bluetooth) {
        throw new Error('Web Bluetooth API is not available in this browser. Please use Chrome or Edge.');
      }

      const device = await nav.bluetooth.requestDevice({
        filters: [{ services: ['heart_rate'] }],
      });

      deviceRef.current = device;
      device.addEventListener('gattserverdisconnected', handleDisconnect);

      const server = await device.gatt?.connect();
      if (!server) throw new Error('Could not connect to GATT server');

      const service = await server.getPrimaryService('heart_rate');
      const characteristic = await service.getCharacteristic('heart_rate_measurement');

      await characteristic.startNotifications();
      characteristic.addEventListener('characteristicvaluechanged', handleHeartRateMeasurement);

      setStatus('connected');
    } catch (error: any) {
      console.error('Bluetooth error:', error);
      setStatus('error');
      setErrorMsg(error.message || 'Failed to connect to device.');
    }
  };

  const disconnect = () => {
    if (deviceRef.current && deviceRef.current.gatt?.connected) {
      deviceRef.current.gatt.disconnect();
    }
    handleDisconnect();
  };

  const handleDisconnect = () => {
    setStatus('disconnected');
    setHeartRate(null);
    deviceRef.current = null;
  };

  const handleHeartRateMeasurement = (event: any) => {
    const value = event.target.value;
    if (!value) return;

    const flags = value.getUint8(0);
    const rate16Bits = flags & 0x1;
    let hr;
    if (rate16Bits) {
      hr = value.getUint16(1, /*littleEndian=*/ true);
    } else {
      hr = value.getUint8(1);
    }
    setHeartRate(hr);
  };

  useEffect(() => {
    return () => {
      if (deviceRef.current && deviceRef.current.gatt?.connected) {
        deviceRef.current.gatt.disconnect();
      }
    };
  }, []);

  // --- SPOTIFY OAUTH LOGIC ---

  const checkSpotifySession = async () => {
    try {
      const res = await fetch('/api/spotify/me');
      if (res.ok) {
        const data = await res.json();
        setSpotifyUser(data);
        fetchPlaylists();
        
        const tokenRes = await fetch('/api/spotify/token');
        if (tokenRes.ok) {
          const tokenData = await tokenRes.json();
          setAccessToken(tokenData.token);
        }
      }
    } catch (e) {
      console.error('Failed to check session', e);
    }
  };

  useEffect(() => {
    checkSpotifySession();

    const handleMessage = (event: MessageEvent) => {
      if (!event.origin.endsWith('.run.app') && !event.origin.includes('localhost')) {
        return;
      }
      if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
        checkSpotifySession();
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  const connectSpotify = async () => {
    try {
      setSpotifyError('');
      const redirectUri = `${window.location.origin}/auth/callback`;
      const response = await fetch(`/api/auth/url?redirect_uri=${encodeURIComponent(redirectUri)}`);
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to get auth URL');
      }
      const { url } = await response.json();

      const authWindow = window.open(url, 'oauth_popup', 'width=600,height=700');
      if (!authWindow) {
        setSpotifyError('Please allow popups for this site to connect your account.');
      }
    } catch (error: any) {
      console.error('OAuth error:', error);
      setSpotifyError(error.message);
    }
  };

  const logoutSpotify = async () => {
    await fetch('/api/spotify/logout');
    setSpotifyUser(null);
    setPlaylists([]);
  };

  const fetchPlaylists = async () => {
    try {
      const res = await fetch('/api/spotify/playlists');
      if (res.ok) {
        const data = await res.json();
        setPlaylists(data.items || []);
      }
    } catch (e) {
      console.error('Failed to fetch playlists', e);
    }
  };

  // --- WEB PLAYBACK SDK ---
  useEffect(() => {
    if (!accessToken) return;

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);

    (window as any).onSpotifyWebPlaybackSDKReady = () => {
      const player = new (window as any).Spotify.Player({
        name: 'Whoop HR Web Player',
        getOAuthToken: async (cb: any) => {
          try {
            const res = await fetch('/api/spotify/token');
            if (res.ok) {
              const data = await res.json();
              setAccessToken(data.token);
              cb(data.token);
            } else {
              cb(accessToken);
            }
          } catch (e) {
            cb(accessToken);
          }
        },
        volume: volume / 100
      });
      playerRef.current = player;

      player.addListener('ready', ({ device_id }: any) => {
        console.log('Ready with Device ID', device_id);
        setWebPlayerDeviceId(device_id);
        setPlayerStatus('Ready');
      });

      player.addListener('not_ready', ({ device_id }: any) => {
        console.log('Device ID has gone offline', device_id);
        setWebPlayerDeviceId(null);
        setPlayerStatus('Offline');
      });

      player.addListener('initialization_error', ({ message }: any) => {
        console.error(message);
        setPlayerStatus('Init Error');
        setSpotifyError(`Player Init Error: ${message}`);
      });

      player.addListener('authentication_error', ({ message }: any) => {
        console.error(message);
        setPlayerStatus('Auth Error');
        setSpotifyError(`Player Auth Error: ${message}. Please click Disconnect and then Connect Spotify again to update your permissions.`);
      });

      player.addListener('account_error', ({ message }: any) => {
        console.error(message);
        setPlayerStatus('Premium Required');
        setSpotifyError(`Account Error: ${message}. Spotify Premium is required for web playback.`);
      });

      player.addListener('player_state_changed', (state: any) => {
        if (!state) return;
        setIsPaused(state.paused);
        setCurrentTrack(state.track_window.current_track);
      });

      player.connect();
    };

    return () => {
      // Cleanup if component unmounts
    };
  }, [accessToken]);

  // --- PLAYBACK LOGIC ---

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value);
    setVolume(val);
    if (playerRef.current) {
      playerRef.current.setVolume(val / 100);
    }
  };

  const activateWebPlayer = async () => {
    if (!webPlayerDeviceId) return;
    try {
      if (playerRef.current && typeof playerRef.current.activateElement === 'function') {
        await playerRef.current.activateElement();
      }
      
      // Attempt to transfer playback to this device, but don't block if it fails.
      // (Spotify sometimes returns 404 if there's no active session to transfer from).
      // Playing a playlist later will automatically target this device anyway.
      fetch('/api/spotify/transfer', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: webPlayerDeviceId })
      }).catch(e => console.error('Optional transfer failed:', e));

      setSpotifyError('');
      setPlayerStatus('Active & Ready');
    } catch (e) {
      console.error(e);
      setSpotifyError('Failed to activate browser audio.');
    }
  };

  const playSpotifyPlaylist = async (uri: string) => {
    try {
      const res = await fetch('/api/spotify/play', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context_uri: uri, device_id: webPlayerDeviceId })
      });
      if (!res.ok) {
        const data = await res.json();
        setSpotifyError(data.error || 'Failed to play playlist');
      } else {
        setSpotifyError('');
      }
    } catch (e) {
      console.error('Play error', e);
    }
  };

  const togglePlayback = async () => {
    if (!playerRef.current) return;
    
    if (currentTrack) {
      playerRef.current.togglePlay().catch((e: any) => console.error('Toggle play error:', e));
    } else {
      // No track loaded, force play via API using current zone or first available playlist
      const currentZone = zones.find(z => z.id === currentZoneId);
      const uriToPlay = currentZone?.playlistUri || playlists[0]?.uri;
      
      const body: any = { device_id: webPlayerDeviceId };
      if (uriToPlay) {
        body.context_uri = uriToPlay;
      }

      try {
        const res = await fetch('/api/spotify/play', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const data = await res.json();
          setSpotifyError(data.error?.message || data.error || 'Failed to start playback. Please select a playlist.');
        } else {
          setSpotifyError('');
        }
      } catch (e) {
        console.error(e);
      }
    }
  };

  const skipNext = () => {
    if (!currentTrack) {
      setSpotifyError('No track playing to skip.');
      return;
    }
    playerRef.current?.nextTrack();
  };

  const skipPrevious = () => {
    if (!currentTrack) {
      setSpotifyError('No track playing to skip.');
      return;
    }
    playerRef.current?.previousTrack();
  };

  const pauseSpotify = async () => {
    try {
      await fetch('/api/spotify/pause', { 
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: webPlayerDeviceId })
      });
    } catch (e) {
      console.error('Pause error', e);
    }
  };

  useEffect(() => {
    if (heartRate === null || !spotifyUser) return;

    const matchedZone = zones.find(z => heartRate >= z.min && heartRate <= z.max);
    const matchedZoneId = matchedZone ? matchedZone.id : null;

    if (matchedZoneId !== currentZoneId) {
      if (zoneTimeoutRef.current) clearTimeout(zoneTimeoutRef.current);

      // Debounce zone change by 3 seconds to prevent rapid switching
      zoneTimeoutRef.current = setTimeout(() => {
        setCurrentZoneId(matchedZoneId);
        if (matchedZone) {
          if (matchedZone.playlistUri) {
            playSpotifyPlaylist(matchedZone.playlistUri);
          } else {
            pauseSpotify();
          }
        }
      }, 3000);
    }
  }, [heartRate, zones, currentZoneId, spotifyUser]);

  // --- ZONE MANAGEMENT ---

  const updateZone = (id: string, field: keyof Zone, value: any) => {
    setZones(prev => prev.map(z => z.id === id ? { ...z, [field]: value } : z));
  };

  const addZone = () => {
    const maxVal = zones.length > 0 ? Math.max(...zones.map(z => z.max)) : 0;
    setZones([...zones, { 
      id: Date.now().toString(), 
      min: maxVal + 1, 
      max: maxVal + 30, 
      playlistUri: null, 
      playlistName: null 
    }]);
  };

  const removeZone = (id: string) => {
    setZones(prev => prev.filter(z => z.id !== id));
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-white p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto flex flex-col gap-8">
        
        {/* TOP ROW: HR & ZONES */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-8">
          
          {/* LEFT COLUMN: HR MONITOR */}
          <div className="md:col-span-5 flex flex-col gap-6">
            <div className="bg-[#151619] rounded-3xl shadow-2xl overflow-hidden border border-white/5 relative p-6 flex flex-col items-center h-full justify-center">
              <div className="absolute top-0 left-1/2 -translate-x-1/2 w-full h-32 bg-red-500/10 blur-[60px] pointer-events-none" />

              <div className="flex items-center gap-2 mb-8 w-full justify-between relative z-10">
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-red-500" />
                <span className="font-medium tracking-wide text-sm text-gray-400 uppercase">Whoop Stream</span>
              </div>
              <div className="flex items-center gap-2">
                <div className={`w-2 h-2 rounded-full ${status === 'connected' ? 'bg-emerald-500 animate-pulse' : status === 'connecting' ? 'bg-yellow-500 animate-pulse' : 'bg-gray-600'}`} />
                <span className="text-xs font-mono text-gray-500 uppercase tracking-wider">
                  {status}
                </span>
              </div>
            </div>

            <div className="relative w-36 h-36 flex items-center justify-center mb-8 z-10">
              <div className="absolute inset-0 border border-dashed border-white/10 rounded-full" />
              
              <div className="flex flex-col items-center">
                <AnimatePresence mode="wait">
                  {status === 'connected' ? (
                    <motion.div
                      key="hr-value"
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      className="flex flex-col items-center"
                    >
                      <motion.div
                        animate={{ scale: heartRate ? [1, 1.1, 1] : 1 }}
                        transition={{ 
                          repeat: Infinity, 
                          duration: heartRate ? 60 / heartRate : 1,
                          ease: "easeInOut"
                        }}
                        className="text-red-500 mb-1"
                      >
                        <Heart className="w-6 h-6 fill-current" />
                      </motion.div>
                      <div className="text-5xl font-mono font-light tracking-tighter">
                        {heartRate !== null ? heartRate : '--'}
                      </div>
                      <div className="text-[10px] font-mono text-gray-500 uppercase tracking-widest mt-1">BPM</div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="disconnected-icon"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex flex-col items-center text-gray-600"
                    >
                      <BluetoothOff className="w-8 h-8 mb-2" />
                      <div className="text-xs font-mono uppercase tracking-widest text-center">
                        {status === 'connecting' ? 'Pairing...' : 'No Signal'}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {status === 'error' && (
              <div className="w-full bg-red-500/10 border border-red-500/20 rounded-xl p-4 mb-8 flex items-start gap-3 text-red-400 relative z-10">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <p className="text-sm">{errorMsg}</p>
              </div>
            )}

            <div className="w-full relative z-10">
              {status === 'connected' ? (
                <button
                  onClick={disconnect}
                  className="w-full py-4 rounded-xl border border-white/10 text-gray-400 hover:text-white hover:bg-white/5 transition-colors font-medium tracking-wide text-sm uppercase"
                >
                  Disconnect
                </button>
              ) : (
                <button
                  onClick={connectToWhoop}
                  disabled={status === 'connecting'}
                  className="w-full py-4 rounded-xl bg-white text-black hover:bg-gray-200 transition-colors font-medium tracking-wide text-sm uppercase flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Bluetooth className="w-4 h-4" />
                  {status === 'connecting' ? 'Connecting...' : 'Connect Whoop'}
                </button>
              )}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: ZONES */}
        <div className="md:col-span-7 flex flex-col gap-6">
          
          {/* Zones Configuration */}
          <div className={`bg-[#151619] rounded-3xl border border-white/5 p-6 md:p-8 transition-opacity duration-300 ${!spotifyUser ? 'opacity-50 pointer-events-none' : ''} h-full`}>
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center gap-2">
                <Settings className="w-5 h-5 text-gray-400" />
                <h2 className="text-lg font-medium">Heart Rate Zones</h2>
              </div>
              <button 
                onClick={addZone}
                className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center hover:bg-white/10 transition-colors"
              >
                <Plus className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-4">
              {zones.map((zone, index) => {
                const isActive = currentZoneId === zone.id;
                return (
                  <div 
                    key={zone.id} 
                    className={`p-4 rounded-2xl border transition-colors ${isActive ? 'border-emerald-500/50 bg-emerald-500/5' : 'border-white/5 bg-black/20'}`}
                  >
                    <div className="flex flex-col md:flex-row gap-4 items-start md:items-center">
                      
                      {/* HR Range Inputs */}
                      <div className="flex items-center gap-2 shrink-0">
                        {isActive && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
                        <div className="flex items-center bg-black/40 rounded-lg border border-white/10 px-3 py-2">
                          <input 
                            type="number" 
                            value={zone.min}
                            onChange={(e) => updateZone(zone.id, 'min', parseInt(e.target.value) || 0)}
                            className="w-12 bg-transparent text-center font-mono text-sm outline-none"
                          />
                          <span className="text-gray-500 px-2">-</span>
                          <input 
                            type="number" 
                            value={zone.max}
                            onChange={(e) => updateZone(zone.id, 'max', parseInt(e.target.value) || 0)}
                            className="w-12 bg-transparent text-center font-mono text-sm outline-none"
                          />
                          <span className="text-xs text-gray-500 ml-2 font-mono">BPM</span>
                        </div>
                      </div>

                      {/* Playlist Selector */}
                      <div className="flex-1 w-full">
                        <select
                          value={zone.playlistUri || ''}
                          onChange={(e) => {
                            const uri = e.target.value;
                            const pl = playlists.find(p => p.uri === uri);
                            updateZone(zone.id, 'playlistUri', uri || null);
                            updateZone(zone.id, 'playlistName', pl ? pl.name : null);
                          }}
                          className="w-full bg-black/40 border border-white/10 rounded-lg px-3 py-2.5 text-sm outline-none focus:border-white/30 appearance-none"
                        >
                          <option value="">No Playlist (Pause)</option>
                          {playlists.map(p => (
                            <option key={p.id} value={p.uri}>{p.name}</option>
                          ))}
                        </select>
                      </div>

                      {/* Delete Button */}
                      <button 
                        onClick={() => removeZone(zone.id)}
                        className="p-2.5 text-gray-500 hover:text-red-400 hover:bg-red-400/10 rounded-lg transition-colors shrink-0"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            
            <div className="mt-6 text-xs text-gray-500 font-mono">
              Note: The built-in web player requires you to interact with the page (click anywhere) before audio can play. Playback changes are delayed by 3 seconds to prevent rapid skipping.
            </div>
          </div>

        </div>
        </div>

        {/* BOTTOM ROW: SPOTIFY PLAYER */}
        <div className="w-full">
          {/* Spotify Connection Card */}
          <div className="bg-[#151619] rounded-3xl border border-white/5 p-6 md:p-8">
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
              <div className="flex items-start gap-4 w-full">
                <div className="w-12 h-12 rounded-full bg-[#1DB954]/10 flex items-center justify-center shrink-0">
                  <Music className="w-6 h-6 text-[#1DB954]" />
                </div>
                <div className="w-full">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 w-full">
                    <div>
                      <h2 className="text-lg font-medium">Spotify Integration</h2>
                      <p className="text-sm text-gray-400">
                        {spotifyUser ? `Connected as ${spotifyUser.display_name}` : 'Connect to play music based on HR zones'}
                      </p>
                    </div>
                    {spotifyUser ? (
                      <button onClick={logoutSpotify} className="px-4 py-2 rounded-full border border-white/10 text-xs font-medium uppercase tracking-wider hover:bg-white/5 transition-colors shrink-0">
                        Disconnect
                      </button>
                    ) : (
                      <button onClick={connectSpotify} className="px-6 py-3 rounded-full bg-[#1DB954] text-black text-sm font-medium uppercase tracking-wider hover:bg-[#1ed760] transition-colors flex items-center justify-center gap-2 shrink-0">
                        Connect Spotify
                      </button>
                    )}
                  </div>

                  {spotifyUser && (
                    <div className="mt-6 pt-6 border-t border-white/10 flex flex-col gap-5 w-full">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full ${playerStatus.includes('Ready') || playerStatus.includes('Active') ? 'bg-emerald-500' : 'bg-yellow-500'}`} />
                          <span className="text-xs font-mono text-gray-500 uppercase tracking-wider">
                            Web Player: {playerStatus}
                          </span>
                        </div>
                        {playerStatus === 'Ready' && (
                          <button 
                            onClick={activateWebPlayer}
                            className="text-xs px-4 py-2 bg-white text-black hover:bg-gray-200 rounded-full transition-colors font-medium tracking-wide"
                          >
                            Activate Player
                          </button>
                        )}
                      </div>
                      
                      {playerStatus.includes('Active') ? (
                        <div className="flex flex-col md:flex-row items-center justify-between gap-6 w-full bg-black/20 p-4 rounded-2xl border border-white/5">
                          {/* Track Info */}
                          <div className="flex-1 min-w-0 flex items-center gap-4 w-full md:w-auto">
                            {currentTrack ? (
                              <>
                                {currentTrack.album?.images?.[0]?.url ? (
                                  <img src={currentTrack.album.images[0].url} alt="Album Art" className="w-12 h-12 rounded-md shadow-md" referrerPolicy="no-referrer" />
                                ) : (
                                  <div className="w-12 h-12 rounded-md bg-white/10 flex items-center justify-center"><Music className="w-5 h-5 text-gray-500" /></div>
                                )}
                                <div className="truncate">
                                  <div className="font-medium truncate text-sm">{currentTrack.name}</div>
                                  <div className="text-xs text-gray-400 truncate">{currentTrack.artists.map((a: any) => a.name).join(', ')}</div>
                                </div>
                              </>
                            ) : (
                              <div className="text-sm text-gray-500 italic">No track playing</div>
                            )}
                          </div>

                          {/* Controls */}
                          <div className="flex items-center gap-6 shrink-0">
                            <button onClick={skipPrevious} className="text-gray-400 hover:text-white transition-colors">
                              <SkipBack className="w-5 h-5" />
                            </button>
                            <button onClick={togglePlayback} className="w-10 h-10 rounded-full bg-white text-black flex items-center justify-center hover:scale-105 transition-transform">
                              {isPaused ? <Play className="w-5 h-5 ml-1" /> : <Pause className="w-5 h-5" />}
                            </button>
                            <button onClick={skipNext} className="text-gray-400 hover:text-white transition-colors">
                              <SkipForward className="w-5 h-5" />
                            </button>
                          </div>

                          {/* Volume */}
                          <div className="flex-1 flex items-center justify-end gap-3 w-full md:w-auto">
                            <Volume2 className="w-4 h-4 text-gray-400" />
                            <input 
                              type="range" 
                              min="0" 
                              max="100" 
                              value={volume} 
                              onChange={handleVolumeChange}
                              className="w-24 h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full"
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-center gap-3">
                          <Volume2 className="w-4 h-4 text-gray-400" />
                          <input 
                            type="range" 
                            min="0" 
                            max="100" 
                            value={volume} 
                            onChange={handleVolumeChange}
                            className="flex-1 h-1.5 bg-white/10 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:rounded-full"
                          />
                          <span className="text-xs font-mono text-gray-400 w-8 text-right">{volume}%</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {spotifyError && (
              <div className="mt-6 p-3 bg-red-500/10 border border-red-500/20 rounded-lg flex items-start gap-2 text-red-400 text-sm">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <p>{spotifyError}</p>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
