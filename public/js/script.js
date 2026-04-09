const statusElement = document.getElementById("status");
const routeForm = document.getElementById("route-form");
const startInput = document.getElementById("start-input");
const destinationInput = document.getElementById("destination-input");
const swapButton = document.getElementById("swap-button");
const distanceValue = document.getElementById("distance-value");

const DEFAULT_CENTER = [20.5937, 78.9629];
const DEFAULT_ZOOM = 5;
const DESTINATION_REACHED_THRESHOLD_METERS = 40;
const ZERO_DISTANCE_THRESHOLD_METERS = 2;

const map = L.map("map", {
    zoomControl: false
}).setView(DEFAULT_CENTER, DEFAULT_ZOOM);

L.control.zoom({
    position: "bottomright"
}).addTo(map);

L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
}).addTo(map);

let routeLine = null;
let startMarker = null;
let destinationMarker = null;
let deviceMarker = null;
let deviceTrailLine = null;
let peerRouteLine = null;

let locationWatcherId = null;
let previousTrackedPoint = null;
let trackedDistanceMeters = 0;
let activeDestination = null;
let hasSnappedToLiveStart = false;
let currentLivePoint = null;

let selfSocketId = null;
let isPeerRouteFetchInFlight = false;
let lastPeerRouteKey = "";
let lastPeerRouteAt = 0;

const peerLocations = new Map();
const peerMarkers = new Map();
const geocodeCache = new Map();

const socket = typeof io === "function" ? io() : null;

const updateStatus = (message) => {
    if (statusElement) {
        statusElement.textContent = message;
    }
};

const isValidCoordinate = (value) => typeof value === "number" && Number.isFinite(value);

const formatDistance = (meters) => {
    if (!Number.isFinite(meters)) return "-";
    return meters >= 1000
        ? `${(meters / 1000).toFixed(1)} km`
        : `${Math.round(meters)} m`;
};

const setDistanceDisplay = (distance) => {
    distanceValue.textContent = formatDistance(distance);
};

const createStartIcon = () =>
    L.divIcon({
        className: "",
        html: '<span style="display:block;width:18px;height:18px;border-radius:999px;background:#0f766e;border:3px solid #ecfeff;box-shadow:0 8px 18px rgba(15,23,42,0.28);"></span>',
        iconSize: [18, 18],
        iconAnchor: [9, 9]
    });

const createDestinationIcon = () =>
    L.divIcon({
        className: "",
        html: '<span style="display:block;width:16px;height:16px;background:#f97316;border:3px solid #fff7ed;box-shadow:0 8px 18px rgba(15,23,42,0.28);transform:rotate(45deg);"></span>',
        iconSize: [18, 18],
        iconAnchor: [9, 9]
    });

const createDeviceIcon = () =>
    L.divIcon({
        className: "",
        html: '<span style="display:block;width:18px;height:18px;border-radius:999px;background:#2563eb;border:3px solid #dbeafe;box-shadow:0 8px 18px rgba(15,23,42,0.28);"></span>',
        iconSize: [18, 18],
        iconAnchor: [9, 9]
    });

const createPeerIcon = () =>
    L.divIcon({
        className: "",
        html: '<span style="display:block;width:18px;height:18px;border-radius:4px;background:#dc2626;border:3px solid #fee2e2;box-shadow:0 8px 18px rgba(15,23,42,0.28);"></span>',
        iconSize: [18, 18],
        iconAnchor: [9, 9]
    });

const startIcon = createStartIcon();
const destinationIcon = createDestinationIcon();
const deviceIcon = createDeviceIcon();
const peerIcon = createPeerIcon();

const setMarkerPosition = (marker, coordinates, icon, label) => {
    if (marker) {
        marker.setLatLng(coordinates);
        marker.setPopupContent(label);
        return marker;
    }
    return L.marker(coordinates, { icon }).addTo(map).bindPopup(label);
};

const clearRoute = () => {
    if (routeLine) {
        map.removeLayer(routeLine);
        routeLine = null;
    }
};

const clearPeerRoute = () => {
    if (peerRouteLine) {
        map.removeLayer(peerRouteLine);
        peerRouteLine = null;
    }
};

const clearLiveTrackingGraphics = () => {
    if (deviceTrailLine) {
        map.removeLayer(deviceTrailLine);
        deviceTrailLine = null;
    }
    if (deviceMarker) {
        map.removeLayer(deviceMarker);
        deviceMarker = null;
    }
};

const resetDestinationTracking = () => {
    previousTrackedPoint = null;
    trackedDistanceMeters = 0;
    activeDestination = null;
    hasSnappedToLiveStart = false;
};

const stopLiveTracking = () => {
    if (locationWatcherId !== null) {
        navigator.geolocation.clearWatch(locationWatcherId);
        locationWatcherId = null;
    }
    resetDestinationTracking();
    currentLivePoint = null;
};

const haversineDistance = (pointA, pointB) => {
    const toRadians = (deg) => (deg * Math.PI) / 180;
    const R = 6371000;
    const lat1 = toRadians(pointA.latitude);
    const lon1 = toRadians(pointA.longitude);
    const lat2 = toRadians(pointB.latitude);
    const lon2 = toRadians(pointB.longitude);
    const dLat = lat2 - lat1;
    const dLon = lon2 - lon1;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const geocodePlace = async (query) => {
    const normalized = query.trim();
    const key = normalized.toLowerCase();
    if (geocodeCache.has(key)) return geocodeCache.get(key);

    const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(normalized)}`
    );
    if (!response.ok) throw new Error("Geocoding request failed.");

    const results = await response.json();
    if (!Array.isArray(results) || results.length === 0)
        throw new Error(`No location found for "${normalized}".`);

    const match = results[0];
    const latitude = Number(match.lat);
    const longitude = Number(match.lon);

    if (!isValidCoordinate(latitude) || !isValidCoordinate(longitude))
        throw new Error(`Invalid coordinates returned for "${normalized}".`);

    const location = { latitude, longitude, label: match.display_name };
    geocodeCache.set(key, location);
    return location;
};

const fetchRoute = async (start, destination) => {
    const response = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${start.longitude},${start.latitude};${destination.longitude},${destination.latitude}?overview=full&geometries=geojson`
    );
    if (!response.ok) throw new Error("Routing request failed.");

    const payload = await response.json();
    const route = payload.routes?.[0];
    if (!route) throw new Error("No drivable route was found.");
    return route;
};

const upsertPeerLocation = (id, point) => {
    if (!id || id === selfSocketId) return;
    peerLocations.set(id, point);

    const label = `User ${id.slice(0, 6)}`;
    const coordinates = [point.latitude, point.longitude];
    const existingMarker = peerMarkers.get(id) || null;
    const nextMarker = setMarkerPosition(existingMarker, coordinates, peerIcon, label);
    peerMarkers.set(id, nextMarker);
};

const removePeerLocation = (id) => {
    const marker = peerMarkers.get(id);
    if (marker) {
        map.removeLayer(marker);
        peerMarkers.delete(id);
    }
    peerLocations.delete(id);

    if (peerLocations.size === 0) {
        clearPeerRoute();
    }
};

const pickNearestPeer = () => {
    if (!currentLivePoint || peerLocations.size === 0) return null;

    let nearestId = null;
    let nearestPoint = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const [id, point] of peerLocations.entries()) {
        const distance = haversineDistance(currentLivePoint, point);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestId = id;
            nearestPoint = point;
        }
    }

    if (!nearestId || !nearestPoint) return null;
    return { id: nearestId, point: nearestPoint, distance: nearestDistance };
};

const updatePeerRoute = async () => {
    const nearestPeer = pickNearestPeer();
    if (!nearestPeer) {
        clearPeerRoute();
        return;
    }

    if (nearestPeer.distance <= ZERO_DISTANCE_THRESHOLD_METERS) {
        clearPeerRoute();
        setDistanceDisplay(0);
        updateStatus("You and the other user are at the same location. Distance is 0 m.");
        return;
    }

    const routeKey = `${currentLivePoint.latitude.toFixed(4)}:${currentLivePoint.longitude.toFixed(4)}:${nearestPeer.point.latitude.toFixed(4)}:${nearestPeer.point.longitude.toFixed(4)}`;
    const now = Date.now();

    if (isPeerRouteFetchInFlight) return;
    if (routeKey === lastPeerRouteKey && now - lastPeerRouteAt < 8000) return;

    isPeerRouteFetchInFlight = true;

    try {
        const route = await fetchRoute(currentLivePoint, nearestPeer.point);
        const routeCoordinates = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);

        if (!peerRouteLine) {
            peerRouteLine = L.polyline(routeCoordinates, {
                color: "#ef4444",
                weight: 5,
                opacity: 0.9,
                dashArray: "8 6"
            }).addTo(map);
        } else {
            peerRouteLine.setLatLngs(routeCoordinates);
        }

        setDistanceDisplay(route.distance);
        updateStatus(`Live shared route active. Distance to nearest user: ${formatDistance(route.distance)}.`);

        lastPeerRouteKey = routeKey;
        lastPeerRouteAt = now;
    } catch (error) {
        setDistanceDisplay(nearestPeer.distance);
        updateStatus(`Live shared distance: ${formatDistance(nearestPeer.distance)} (direct line).`);
    } finally {
        isPeerRouteFetchInFlight = false;
    }
};

const handleLivePosition = (position) => {
    const latitude = Number(position.coords.latitude);
    const longitude = Number(position.coords.longitude);

    if (!isValidCoordinate(latitude) || !isValidCoordinate(longitude)) return;

    const currentPoint = { latitude, longitude };
    const coordinates = [latitude, longitude];
    currentLivePoint = currentPoint;

    deviceMarker = setMarkerPosition(
        deviceMarker,
        coordinates,
        deviceIcon,
        "My live location"
    );

    if (socket?.connected) {
        socket.emit("location:update", currentPoint);
    }

    if (activeDestination) {
        if (!hasSnappedToLiveStart) {
            startMarker = setMarkerPosition(
                startMarker,
                coordinates,
                startIcon,
                "Current location (live start)"
            );
            hasSnappedToLiveStart = true;
        }

        if (previousTrackedPoint) {
            trackedDistanceMeters += haversineDistance(previousTrackedPoint, currentPoint);
        }

        previousTrackedPoint = currentPoint;

        if (!deviceTrailLine) {
            deviceTrailLine = L.polyline([coordinates], {
                color: "#2563eb",
                weight: 5,
                opacity: 0.85,
                dashArray: "10 8"
            }).addTo(map);
        } else {
            deviceTrailLine.addLatLng(coordinates);
        }

        const distanceToDestination = haversineDistance(currentPoint, activeDestination);
        setDistanceDisplay(distanceToDestination);
        updateStatus(
            `Live tracking active. Remaining ${formatDistance(distanceToDestination)} | Traveled ${formatDistance(trackedDistanceMeters)}.`
        );

        if (distanceToDestination <= DESTINATION_REACHED_THRESHOLD_METERS) {
            updateStatus("Destination reached. Live tracking still on for shared map visibility.");
            resetDestinationTracking();
        }
    }

    updatePeerRoute();
};

const ensureLocationWatcher = () => {
    if (locationWatcherId !== null) return;

    if (!navigator.geolocation) {
        updateStatus("Geolocation is not supported in this browser.");
        return;
    }

    locationWatcherId = navigator.geolocation.watchPosition(
        handleLivePosition,
        (error) => {
            const messages = {
                1: "Location permission denied. Live tracking could not start.",
                2: "Location information unavailable for live tracking.",
                3: "Location request timed out during live tracking."
            };
            updateStatus(messages[error.code] || "Unable to live track your location.");
            stopLiveTracking();
        },
        {
            enableHighAccuracy: true,
            maximumAge: 0,
            timeout: 12000
        }
    );
};

const startLiveTracking = (destination) => {
    resetDestinationTracking();
    clearLiveTrackingGraphics();

    activeDestination = destination;
    trackedDistanceMeters = 0;
    previousTrackedPoint = null;
    hasSnappedToLiveStart = false;

    ensureLocationWatcher();
    updateStatus("Route ready. Waiting for live GPS updates...");
};

const drawRoute = async () => {
    const startQuery = startInput.value.trim();
    const destinationQuery = destinationInput.value.trim();

    if (!startQuery) {
        updateStatus("Enter a starting point.");
        startInput.focus();
        return;
    }
    if (!destinationQuery) {
        updateStatus("Enter a destination.");
        destinationInput.focus();
        return;
    }

    updateStatus("Finding locations and calculating route...");

    try {
        const [start, destination] = await Promise.all([
            geocodePlace(startQuery),
            geocodePlace(destinationQuery)
        ]);

        const startCoordinates = [start.latitude, start.longitude];
        const destinationCoordinates = [destination.latitude, destination.longitude];

        startMarker = setMarkerPosition(startMarker, startCoordinates, startIcon, "Start");
        destinationMarker = setMarkerPosition(destinationMarker, destinationCoordinates, destinationIcon, "Destination");

        startInput.value = start.label;
        destinationInput.value = destination.label;

        const sameLocationDistance = haversineDistance(start, destination);
        if (sameLocationDistance <= ZERO_DISTANCE_THRESHOLD_METERS) {
            clearRoute();
            clearLiveTrackingGraphics();
            resetDestinationTracking();
            setDistanceDisplay(0);
            map.setView(startCoordinates, 16);
            updateStatus("Start and destination are the same. Distance is 0 m.");
            return;
        }

        const route = await fetchRoute(start, destination);
        const routeCoordinates = route.geometry.coordinates.map(([lng, lat]) => [lat, lng]);

        clearRoute();
        routeLine = L.polyline(routeCoordinates, {
            color: "#0f766e",
            weight: 6,
            opacity: 0.88
        }).addTo(map);

        setDistanceDisplay(route.distance);
        map.fitBounds(routeLine.getBounds(), { padding: [48, 48] });

        startLiveTracking({
            latitude: destination.latitude,
            longitude: destination.longitude
        });
    } catch (error) {
        console.error(error);
        clearRoute();
        clearLiveTrackingGraphics();
        resetDestinationTracking();
        setDistanceDisplay(null);
        updateStatus(error.message || "Unable to build a route right now.");
    }
};

if (socket) {
    socket.on("connect", () => {
        selfSocketId = socket.id;
        ensureLocationWatcher();
    });

    socket.on("users:snapshot", (users) => {
        if (!Array.isArray(users)) return;

        for (const user of users) {
            const latitude = Number(user?.latitude);
            const longitude = Number(user?.longitude);
            if (!isValidCoordinate(latitude) || !isValidCoordinate(longitude)) continue;
            if (user.id === selfSocketId) continue;

            upsertPeerLocation(user.id, { latitude, longitude });
        }

        updatePeerRoute();
    });

    socket.on("user:location", (user) => {
        const latitude = Number(user?.latitude);
        const longitude = Number(user?.longitude);

        if (!user?.id) return;
        if (user.id === selfSocketId) return;
        if (!isValidCoordinate(latitude) || !isValidCoordinate(longitude)) return;

        upsertPeerLocation(user.id, { latitude, longitude });
        updatePeerRoute();
    });

    socket.on("user:left", (payload) => {
        removePeerLocation(payload?.id);
        updatePeerRoute();
    });
} else {
    ensureLocationWatcher();
}

routeForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await drawRoute();
});

swapButton.addEventListener("click", () => {
    const prev = startInput.value;
    startInput.value = destinationInput.value;
    destinationInput.value = prev;
    updateStatus("Starting point and destination swapped.");
});

setDistanceDisplay(null);
