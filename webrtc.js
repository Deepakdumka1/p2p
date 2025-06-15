class P2PConnection {
    constructor(socket, isTeacher) {
        this.socket = socket;
        this.isTeacher = isTeacher;
        this.peer = null;
        this.fileChunks = new Map();
        this.setupSocketListeners();
        console.log('P2PConnection initialized as:', isTeacher ? 'teacher' : 'student');
    }

    setupSocketListeners() {
        // Handle signaling data
        this.socket.on('signal', async (data) => {
            console.log('Received signal:', this.isTeacher ? 'teacher' : 'student');
            try {
                if (!this.peer && !this.isTeacher) {
                    // Student: Initialize peer when first signal is received
                    this.initializePeer(data.targetId);
                }
                if (this.peer && !this.peer.destroyed) {
                    await this.peer.signal(data.signal);
                } else if (this.isTeacher) {
                    // Reinitialize if peer was destroyed
                    this.initializePeer(data.targetId);
                    await this.peer.signal(data.signal);
                }
            } catch (err) {
                console.error('Error handling signal:', err);
            }
        });

        // Handle student joining (teacher side)
        if (this.isTeacher) {
            this.socket.on('studentJoined', (studentId) => {
                console.log('Teacher: Student joined with ID:', studentId);
                if (!this.peer || this.peer.destroyed) {
                    this.initializePeer(studentId);
                }
            });
        }
    }

    initializePeer(peerId) {
        console.log('Initializing peer as:', this.isTeacher ? 'teacher' : 'student');
        // Create a new SimplePeer instance
        this.peer = new SimplePeer({
            initiator: this.isTeacher,
            trickle: true,
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    { urls: 'stun:stun3.l.google.com:19302' },
                    { urls: 'stun:stun4.l.google.com:19302' }
                ]
            }
        });

        // Handle peer signals
        this.peer.on('signal', (data) => {
            console.log('Sending signal as:', this.isTeacher ? 'teacher' : 'student');
            this.socket.emit('signal', {
                signal: data,
                targetId: peerId
            });
        });

        // Handle peer connection
        this.peer.on('connect', () => {
            console.log('Peer connection established for:', this.isTeacher ? 'teacher' : 'student');
            this.onPeerConnected();
        });

        // Handle incoming data
        this.peer.on('data', (data) => {
            this.handleIncomingData(data);
        });

        // Handle errors
        this.peer.on('error', (err) => {
            console.error('Peer error:', err);
            // Don't destroy the peer immediately on error
            if (err.code !== 'ERR_DATA_CHANNEL') {
                this.destroy();
            }
        });

        // Handle close
        this.peer.on('close', () => {
            console.log('Peer connection closed for:', this.isTeacher ? 'teacher' : 'student');
            this.onPeerDisconnected();
            // Add reconnection logic
            setTimeout(() => {
                if (this.isTeacher && peerId) {
                    this.initializePeer(peerId);
                }
            }, 1000);
        });
    }

    handleIncomingData(data) {
        console.log('Received data type:', typeof data);
        try {
            const message = JSON.parse(data);
            console.log('Received message type:', message.type);

            switch (message.type) {
                case 'file-start':
                    console.log('Starting to receive file:', message.fileName);
                    // Clean up any existing transfer with the same ID
                    if (this.fileChunks.has(message.fileId)) {
                        this.fileChunks.delete(message.fileId);
                    }
                    this.fileChunks.set(message.fileId, {
                        name: message.fileName,
                        type: message.fileType,
                        size: message.fileSize,
                        chunks: [],
                        receivedSize: 0,
                        completed: false
                    });
                    break;

                case 'file-chunk':
                    const fileInfo = this.fileChunks.get(message.fileId);
                    if (fileInfo && !fileInfo.completed) {
                        fileInfo.chunks.push(message.chunk);
                        fileInfo.receivedSize += message.chunk.length;

                        // Calculate and report progress
                        const progress = (fileInfo.receivedSize / fileInfo.size) * 100;
                        this.onFileProgress(message.fileId, Math.min(progress, 100));
                        console.log('File receive progress:', Math.round(progress) + '%');

                        // Check if file is complete
                        if (fileInfo.receivedSize >= fileInfo.size) {
                            console.log('File reception completed:', fileInfo.name);
                            fileInfo.completed = true;
                            this.assembleFile(message.fileId);
                        }
                    }
                    break;

                default:
                    console.warn('Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('Error handling incoming data:', error);
        }
    }

    assembleFile(fileId) {
        const fileInfo = this.fileChunks.get(fileId);
        if (!fileInfo) return;

        try {
            console.log('Assembling file:', fileInfo.name);
            // Convert base64 chunks to Blob
            const chunks = fileInfo.chunks.map(chunk => 
                Uint8Array.from(atob(chunk), c => c.charCodeAt(0))
            );
            const blob = new Blob(chunks, { type: fileInfo.type });
            
            console.log('File assembled successfully:', fileInfo.name);
            this.onFileReceived(fileId, fileInfo.name, blob);
            
            // Clean up after successful assembly
            this.fileChunks.delete(fileId);
            console.log('Cleaned up file chunks for:', fileInfo.name);
        } catch (error) {
            console.error('Error assembling file:', error);
        }
    }

    async sendFile(file) {
        if (!this.peer || !this.peer.connected) {
            throw new Error('No peer connection available');
        }

        console.log('Starting to send file:', file.name, 'size:', file.size);
        const fileId = Math.random().toString(36).substring(2);
        const chunkSize = 16384; // 16KB chunks
        let offset = 0;

        try {
            // Send file metadata
            console.log('Sending file metadata');
            this.peer.send(JSON.stringify({
                type: 'file-start',
                fileId: fileId,
                fileName: file.name,
                fileType: file.type,
                fileSize: file.size
            }));

            // Read and send file chunks
            while (offset < file.size) {
                const chunk = file.slice(offset, offset + chunkSize);
                const buffer = await chunk.arrayBuffer();
                const base64Chunk = btoa(String.fromCharCode(...new Uint8Array(buffer)));

                this.peer.send(JSON.stringify({
                    type: 'file-chunk',
                    fileId: fileId,
                    chunk: base64Chunk
                }));

                offset += chunkSize;
                const progress = (offset / file.size) * 100;
                this.onFileProgress(fileId, Math.min(progress, 100));
                console.log('File transfer progress:', Math.round(progress) + '%');

                // Add a small delay to prevent overwhelming the connection
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            console.log('File transfer completed:', file.name);
        } catch (error) {
            console.error('Error during file transfer:', error);
            throw error;
        }
    }

    // Event handler placeholders - to be overridden by the application
    onPeerConnected() {}
    onPeerDisconnected() {}
    onFileProgress(fileId, progress) {}
    onFileReceived(fileId, fileName, blob) {}

    // Clean up
    destroy() {
        if (this.peer) {
            this.peer.destroy();
            this.peer = null;
        }
    }
} 