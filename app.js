const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const liveUsers = new Map();

const isValidCoordinate = (value) =>
    typeof value === 'number' && Number.isFinite(value);

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
    res.render('index');
});

io.on('connection', (socket) => {
    const usersSnapshot = Array.from(liveUsers.entries()).map(([id, location]) => ({
        id,
        ...location
    }));

    socket.emit('users:snapshot', usersSnapshot);

    socket.on('location:update', (payload) => {
        const latitude = Number(payload?.latitude);
        const longitude = Number(payload?.longitude);

        if (!isValidCoordinate(latitude) || !isValidCoordinate(longitude)) return;
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return;

        const location = {
            latitude,
            longitude,
            updatedAt: Date.now()
        };

        liveUsers.set(socket.id, location);
        io.emit('user:location', { id: socket.id, ...location });
    });

    socket.on('disconnect', () => {
        liveUsers.delete(socket.id);
        io.emit('user:left', { id: socket.id });
    });
});

server.listen(3000, () => {
    console.log('Server is running on port 3000');
});
