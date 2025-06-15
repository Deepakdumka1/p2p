const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.static(path.join(__dirname)));

// Store active sessions
const activeSessions = new Map();

// Generate a random 5-character alphanumeric code
function generateSessionCode() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    // Handle session creation (teacher)
    socket.on('createSession', () => {
        let sessionCode;
        do {
            sessionCode = generateSessionCode();
        } while (activeSessions.has(sessionCode));

        // Store the session with the socket ID
        activeSessions.set(sessionCode, {
            teacherId: socket.id,
            students: new Set()
        });

        // Send the session code back to the teacher
        socket.emit('sessionCreated', sessionCode);
        socket.join(sessionCode); // Add this line for teacher to join room
        console.log('Session created:', sessionCode, 'by teacher:', socket.id);
    });

    // Handle student joining
    socket.on('joinSession', (sessionCode) => {
        console.log('Student', socket.id, 'attempting to join session:', sessionCode);
        const session = activeSessions.get(sessionCode);
        if (session) {
            session.students.add(socket.id);
            socket.join(sessionCode); // Add this line for student to join room
            socket.emit('sessionJoined', sessionCode);
            
            // Notify teacher about new student
            io.to(session.teacherId).emit('studentJoined', socket.id);
            console.log('Student', socket.id, 'joined session:', sessionCode, 'teacher:', session.teacherId);
        } else {
            console.log('Invalid session code attempt:', sessionCode);
            socket.emit('sessionError', 'Invalid session code');
        }
    });

    // Handle WebRTC signaling
    socket.on('signal', ({ targetId, signal }) => {
        console.log('Signaling from', socket.id, 'to', targetId);
        io.to(targetId).emit('signal', {
            signal: signal,
            targetId: socket.id
        });
    });

    // Handle group chat messages
    socket.on('chatMessage', ({ sessionCode, message, sender }) => {
        console.log('Chat message for session', sessionCode, 'from', sender, ':', message);
        // Broadcast to everyone in the session except sender
        socket.broadcast.to(sessionCode).emit('chatMessage', { message, sender });
        // Also send back to sender
        socket.emit('chatMessage', { message, sender });
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        // Clean up sessions when teacher disconnects
        for (const [code, session] of activeSessions.entries()) {
            if (session.teacherId === socket.id) {
                activeSessions.delete(code);
                io.to(code).emit('sessionEnded');
                console.log('Session ended:', code, 'due to teacher disconnect');
            } else if (session.students.has(socket.id)) {
                session.students.delete(socket.id);
                io.to(session.teacherId).emit('studentLeft', socket.id);
                console.log('Student left session:', code);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 