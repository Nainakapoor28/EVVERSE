// Global data store for state-city mapping
let allLocationsData = {}; 
// Globals for Map state 
let currentMap = null; 
let allStationData = [];
let searchOrigin = { lat: 0, lon: 0 };
let directionsRenderer = null;

document.addEventListener("DOMContentLoaded", () => {
    initializeEvVerse();
    if (window.mapsAPILoaded && window.pendingMapCalls.length > 0) {
        console.log("Processing pending map calls immediately after main.js loads.");
        while (window.pendingMapCalls.length > 0) {
            const call = window.pendingMapCalls.shift();
            // Use a slight delay to ensure the DOM is fully ready for map injection
            if (window.drawAllStationsMap) {
                setTimeout(() => window.drawAllStationsMap(call.userLat, call.userLon, call.stations, 'map'), 100); 
            }
        }
    }
});


function initializeEvVerse() {
    if (document.querySelector(".battery-type-title")) {
        updateBatteryType();
        updateButtonStates();
        equalizeInfoBoxHeights();
    }

    if (document.getElementById("stateInput")) {
        fetchLocations();
    }
 
    const toggle = document.getElementById("locationModeToggle");
    if (toggle) {
        toggle.addEventListener('change', handleLocationModeToggle);
        handleLocationModeToggle(); 
    }
    const hamburger = document.querySelector(".hamburger");
    const navMenu = document.querySelector(".nav-menu");

    if (hamburger && navMenu) {
        hamburger.addEventListener("click", () => {
            navMenu.classList.toggle("active");
        });
    }
}

function fetchLocations() {
    fetch("/locations")
        .then(response => {
             if (!response.ok) {
                throw new Error(`HTTP Error: ${response.status} loading /locations.`);
             }
             return response.json();
        })
        .then(data => {
            allLocationsData = data.cities_by_state;
            populateStateDropdown(data.states);
        })
        .catch(error => {
            console.error("Error fetching location data:", error);
            const statusDiv = document.getElementById('locationStatus');
            if(statusDiv) statusDiv.textContent = '⚠️ Could not load location data. Manual lookup may fail.';
        });
}

function populateStateDropdown(states) {
    const stateSelect = document.getElementById("stateInput");
    if (!stateSelect) return;
    
    stateSelect.innerHTML = '<option value="" disabled selected>Select State</option>';
    
    states.forEach(state => {
        const option = document.createElement("option");
        option.value = state;
        option.textContent = state;
        stateSelect.appendChild(option);
    });

    stateSelect.addEventListener("change", handleStateChange);
}

function handleStateChange() {
    const stateSelect = document.getElementById("stateInput");
    const citySelect = document.getElementById("cityInput");
    const selectedState = stateSelect.value;

    citySelect.innerHTML = '<option value="" selected>Select City (Optional)</option>';

    if (!selectedState || !allLocationsData[selectedState]) {
        console.warn("No city list found for state:", selectedState);
        return;
    }

    const cities = allLocationsData[selectedState];

    if (!Array.isArray(cities) || cities.length === 0) {
        console.warn(`State "${selectedState}" has no cities in dataset.`);
        return;
    }

    cities.forEach(city => {
        if (city && typeof city === "string" && city.trim() !== "") {
            const option = document.createElement("option");
            option.value = city;
            option.textContent = city;
            citySelect.appendChild(option);
        }
    });
}

function handleLocationModeToggle() {
    const toggle = document.getElementById("locationModeToggle");
    const statusDiv = document.getElementById('locationStatus');
    const latInput = document.getElementById('userLat');
    const lonInput = document.getElementById('userLon');
    const stateInput = document.getElementById('stateInput');
    const cityInput = document.getElementById('cityInput');
    const areaInput = document.getElementById('areaInput');

    if (toggle.checked) {
        stateInput.value = '';
        cityInput.value = '';
        areaInput.value = '';
        
        stateInput.disabled = true;
        cityInput.disabled = true;
        areaInput.disabled = true;
        stateInput.removeAttribute('required');
        
        statusDiv.textContent = 'Fetching current location...';
        
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (position) => {
                    latInput.value = position.coords.latitude;
                    lonInput.value = position.coords.longitude;
                    statusDiv.textContent = 'Location set! Click "Find Charger".';
                },
                (error) => {
                    statusDiv.textContent = '❌ Geolocation failed. Please use Manual Entry.';
                    console.error("Geolocation Error:", error.message);
                    toggle.checked = false;
                    handleLocationModeToggle(); 
                },
                { enableHighAccuracy: true, timeout: 5000, maximumAge: 0 }
            );
        } else {
            statusDiv.textContent = '❌ Browser does not support Geolocation. Please use Manual Entry.';
            toggle.checked = false;
            handleLocationModeToggle();
        }

    } else {
        latInput.value = '';
        lonInput.value = '';
        
        stateInput.disabled = false;
        cityInput.disabled = false;
        areaInput.disabled = false;
        stateInput.setAttribute('required', 'required'); 
        statusDiv.textContent = 'Using Manual Location.';
    }
}

/**
 * @param {number} targetLat - Latitude of the station destination.
 * @param {number} targetLon - Longitude of the station destination.
 */
function drawRouteToStation(targetLat, targetLon) {
    if (!currentMap || !directionsRenderer || !searchOrigin.lat || !searchOrigin.lon) {
        console.error("Map components or origin location not initialized.");
        return;
    }
    
    directionsRenderer.setDirections({ routes: [] }); 

    const origin = { lat: searchOrigin.lat, lng: searchOrigin.lon };
    const destination = { lat: targetLat, lng: targetLon };

    const directionsService = new google.maps.DirectionsService();

    directionsService.route({
        origin: origin,
        destination: destination,
        travelMode: google.maps.TravelMode.DRIVING,
    }, (response, status) => {
        if (status === 'OK') {
            directionsRenderer.setDirections(response);
        } else {
            console.error('Directions service failed for clicked station:', status);
        }
    });
}

/**
 * @param {number} userLat - Latitude of the search origin (user's GPS or geocoded location).
 * @param {number} userLon - Longitude of the search origin.
 * @param {Array<Object>} stations - Array of station objects.
 * @param {string} mapContainerId - ID of the map div.
 */
function drawAllStationsMap(userLat, userLon, stations, mapContainerId) {
    const mapDiv = document.getElementById(mapContainerId);
    if (!mapDiv) return;
    allStationData = stations;
    searchOrigin = { lat: userLat, lon: userLon };
    
    mapDiv.innerHTML = ''; // Clear loading message

    const origin = { lat: userLat, lng: userLon };
    const map = new google.maps.Map(mapDiv, {
        zoom: 12,
        center: origin,
        disableDefaultUI: false, 
    });
    currentMap = map;

    directionsRenderer = new google.maps.DirectionsRenderer({ 
        map: map, 
        suppressMarkers: true, 
        polylineOptions: {
            strokeColor: '#2196F3', 
            strokeOpacity: 0.8,
            strokeWeight: 6
        }
    }); 

    let bounds = new google.maps.LatLngBounds();
    bounds.extend(origin);
    
    const infoWindow = new google.maps.InfoWindow();

    new google.maps.Marker({
        position: origin,
        map: map,
        title: 'Your Search Location',
        icon: {
            url: "http://maps.google.com/mapfiles/ms/icons/blue-dot.png", 
            scaledSize: new google.maps.Size(35, 35)
        }
    });

    const directionsService = new google.maps.DirectionsService();

    stations.forEach((station, index) => {
        const stationPos = { lat: station.lattitude || station.latitude, lng: station.longitude };
        bounds.extend(stationPos); 
        const marker = new google.maps.Marker({
            position: stationPos,
            map: map,
            title: station.station_name,
            label: {
                text: `${index + 1}`,
                color: 'white',
                fontWeight: 'bold',
            },
            icon: {
                url: "http://maps.google.com/mapfiles/ms/icons/green-dot.png", 
                scaledSize: new google.maps.Size(35, 35)
            }
        });
        
        marker.addListener('click', () => {
        
            drawRouteToStation(station.lattitude || station.latitude, station.longitude);
            const mapsLink = `https://www.google.com/maps/dir/${searchOrigin.lat},${searchOrigin.lon}/${station.latitude},${station.longitude}`;

            const infoContent = `
                <div style="color: black; max-width: 200px;">
                    <h4 style="margin-bottom: 5px; font-size: 16px;">${station.station_name}</h4>
                    <p style="margin-bottom: 10px; font-size: 12px; line-height: 1.3;">${station.address}</p>
                    <a 
                        href="${mapsLink}" 
                        target="_blank" 
                        class="btn btn-primary"
                        style="background-color: #2196F3; color: white; padding: 8px 12px; border-radius: 4px; text-decoration: none; font-size: 14px; display: block; text-align: center;">
                        Get Directions
                    </a>
                </div>
            `;
            
            infoWindow.setContent(infoContent);
            infoWindow.open(map, marker);
        });
        directionsService.route({
            origin: origin,
            destination: stationPos,
            travelMode: google.maps.TravelMode.DRIVING,
        }, (response, status) => {
            if (status === 'OK') {
                const route = response.routes[0];
                const durationText = route.legs[0].duration.text;
                
                if (index === 0) {
                    directionsRenderer.setDirections(response);
                }
                
                updateStationTime(index, durationText); 
            } else {
                console.error(`Route/Time calculation failed for station ${index + 1}:`, status);
                updateStationTime(index, 'Time N/A');
            }
        });
    });
    
    map.fitBounds(bounds);

    if (map.getZoom() > 15) {
        map.setZoom(15); 
    }
}



function handleLocateSubmit(event) {
    event.preventDefault();

    const stateInput = document.getElementById("stateInput");
    const state = stateInput.value.trim();
    const city = document.getElementById("cityInput").value.trim(); 
    const area = document.getElementById("areaInput").value.trim();
    const userLat = document.getElementById("userLat").value;
    const userLon = document.getElementById("userLon").value;
    const toggle = document.getElementById("locationModeToggle");

    
    const useCurrentLocation = toggle.checked;

    
    if (useCurrentLocation) {
        if (!userLat || !userLon) {
             document.getElementById('locationStatus').textContent = '⚠️ Current Location coordinates are missing. Please try toggling off and on again.';
             return;
        }
    } else if (!state) { 
        document.getElementById('locationStatus').textContent = '⚠️ Please select a State or switch to Current Location mode!';
        return;
    }
    
   
    const resultsSection = document.getElementById("resultsSection");
    const stationContainer = document.getElementById("stationContainer");
    stationContainer.innerHTML = '';
    const mapDiv = document.getElementById('map');
    if (mapDiv) mapDiv.innerHTML = 'Map will load here'; 
    
    
    stationContainer.innerHTML = '<p class="loading-message">Searching for chargers...</p>';
    resultsSection.style.display = "block";
    
    let postData;
    let url = "/recommend"; 
    
    
    if (useCurrentLocation) {
        postData = {
            latitude: parseFloat(userLat),
            longitude: parseFloat(userLon)
        };
    } else {
        
        const finalCity = (city === 'Select City (Optional)') ? '' : city;
        postData = {
            state: state,
            city: finalCity, 
            area: area
        };
    }

    
    document.getElementById('findChargerBtn').disabled = true;

    fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(postData)
    })
    .then(response => {
        document.getElementById('findChargerBtn').disabled = false; 
        if (!response.ok) {
            if (response.status === 500) {
                 return response.json().catch(() => {
                    throw new Error(`Server Error (${response.status}): The server crashed.`);
                 });
            }
            throw new Error(`HTTP error! Status: ${response.status}.`);
        }
        return response.json();
    })
    .then(data => {
        stationContainer.innerHTML = ''; 

        const recommendations = data.recommendations || [];
        const hasError = !!data.error;

        if (recommendations.length > 0) {
            
            
            const originLat = data.origin_latitude; 
            const originLon = data.origin_longitude; 
            
            
            searchOrigin.lat = originLat;
            searchOrigin.lon = originLon;
            
            resultsSection.querySelector('h2').textContent = hasError 
                ? "Nearest Suggestion Found"
                : "Top Nearby Stations Found";
            
            
            renderStationCards(recommendations, hasError, data.error, true);
            
           
            if (window.mapsAPILoaded && originLat && originLon) {
                
                drawAllStationsMap(originLat, originLon, recommendations, 'map');
            } else if (!window.mapsAPILoaded) {
                
                window.pendingMapCalls.push({ 
                    userLat: originLat, 
                    userLon: originLon, 
                    stations: recommendations 
                });
                mapDiv.innerHTML = '<p class="loading-message">Map is loading. Please wait. Once loaded, markers and the route will appear.</p>';
            } else {
                 mapDiv.innerHTML = '<p class="loading-message">Cannot calculate route: Origin location missing.</p>';
                 recommendations.forEach((_, i) => updateStationTime(i, 'Time N/A'));
            }
            
            resultsSection.scrollIntoView({ behavior: 'smooth' });

        } else if (hasError) {
            resultsSection.querySelector('h2').textContent = "Search Failed";
            stationContainer.innerHTML = `
                <div class="alert-box error-note" style="border: 2px solid red; padding: 15px;">
                    <p><strong>Error:</strong> ${data.error}</p>
                    <p>Please try a different city or verify the spelling.</p>
                </div>
            `;
            resultsSection.scrollIntoView({ behavior: 'smooth' });
        } else {
            resultsSection.querySelector('h2').textContent = "Search Failed";
            stationContainer.innerHTML = `
                <div class="alert-box critical-error-note" style="border: 2px solid red; padding: 15px;">
                    <p>No station data received from the server. Try again.</p>
                </div>
            `;
        }
        

    })
    .catch(error => {
        const currentPort = window.location.port || '80';
        console.error("Error fetching recommendations:", error);
        resultsSection.querySelector('h2').textContent = "Connection Error";
        stationContainer.innerHTML = `
             <div class="alert-box critical-error-note" style="border: 2px solid red; padding: 15px;">
                <p><strong>CRITICAL ERROR:</strong> Failed to communicate with the Flask server.</p>
                <p>Details: ${error.message}</p>
                <p>Please ensure the Flask server is running at <code>http://${window.location.hostname}:${currentPort}</code> in your terminal.</p>
             </div>
        `;
        resultsSection.style.display = "block";
        resultsSection.scrollIntoView({ behavior: 'smooth' });
        

        document.getElementById('findChargerBtn').disabled = false;
      
    });
}



function renderStationCards(recommendations, hasError, errorMessage, loadingTime = false) {
    const stationContainer = document.getElementById("stationContainer");
    stationContainer.innerHTML = '';
    
    if (hasError) {
        stationContainer.innerHTML += `
            <div class="alert-box suggestion-note" style="grid-column: 1 / -1; padding: 8px; border: 2px solid #ffffffff; border-radius: 8px; text-align: center; margin-top:10px;">
                <p style="margin: 0;"><b><strong>${errorMessage}</strong></b></p>
            </div>
        `;
    }

    recommendations.forEach((station, index) => {
        const stationDiv = document.createElement('div');
        stationDiv.className = hasError ? 'station-card suggestion' : 'station-card'; 
        stationDiv.id = `station-${index}`; // Add unique ID for updating
        
        let travelTimePlaceholder = loadingTime ? 'Calculating time...' : 'N/A';
        
        
        const mapsLink = `https://www.google.com/maps/dir/${searchOrigin.lat},${searchOrigin.lon}/${station.latitude},${station.longitude}`;

        stationDiv.innerHTML = `
            <h3>${index + 1}. ${station.station_name}</h3>
            <p><strong>Address:</strong> ${station.address}</p>
            <p><strong>Distance:</strong> ${station.distance} km</p>
            <p><strong>Time:</strong> <span id="time-${index}">${travelTimePlaceholder}</span></p>
            <a 
                href="${mapsLink}" 
                target="_blank" 
                class="btn btn-primary"
                style="background-color: #2196F3; display: block; text-align: center;">
                Open in Google Maps
            </a>
        `;
        stationContainer.appendChild(stationDiv);
    });
}

function updateStationTime(index, durationText) {
    const timeSpan = document.getElementById(`time-${index}`);
    if (timeSpan) {
        timeSpan.textContent = durationText;
    }
}

window.addEventListener("scroll", function () {
  const navbar = document.querySelector(".navbar");

  if (window.scrollY > 10) {
    navbar.classList.add("scrolled");
  } else {
    navbar.classList.remove("scrolled");
  }
});
function toggleFAQ(button) {
    const faqItem = button.parentElement;
    const answer = faqItem.querySelector(".faq-answer");
    const icon = button.querySelector(".faq-icon");

   
    document.querySelectorAll(".faq-answer").forEach(a => {
        if (a !== answer) a.classList.remove("show");
        a.style.maxHeight = null;
    });

    document.querySelectorAll(".faq-question").forEach(q => {
        if (q !== button) q.classList.remove("active");
    });

   
    button.classList.toggle("active");

    if (answer.classList.contains("show")) {
        answer.classList.remove("show");
        answer.style.maxHeight = null;
    } else {
        answer.classList.add("show");
        answer.style.maxHeight = answer.scrollHeight + "px";
    }
}


let currentBatteryIndex = 0;

const batteryTypes = [
  {
    title: "Lithium-Ion Batteries",
    description:
      "Lithium-ion batteries are lightweight, efficient, and high-energy-density rechargeable batteries widely used in EVs. They deliver strong performance, fast charging, and a long lifespan, making them the most preferred battery type in modern electric vehicles.",
    image: "images/lithium.png"

  },
  {
    title: "Nickel-Metal Hydride Batteries",
    description:
      "Nickel-metal hydride batteries are durable, reliable rechargeable batteries with a long lifespan and strong performance, commonly used in hybrid vehicles.",
    image: "images/nickel.png"
  },

  {
    title: "Sodium-ion",
    description:
      "Sodium-ion batteries are a cost-effective and emerging alternative to lithium-ion batteries, offering a promising solution for low-range electric vehicles due to their affordability and abundant raw materials.",
    image: "images/sodium.png" 
   },
  {
    title: "Lead-Acid Batteries",
    description:
      "Lead-acid batteries are affordable, easy-to-recycle rechargeable batteries commonly used in low-cost EVs and hybrid vehicles. They provide basic, reliable power and are valued for their simplicity and widespread availability.",
    image: "images/lead_Acid.png"
  },
];

function updateBatteryType() {
  const currentType = batteryTypes[currentBatteryIndex];
  document.querySelector(".battery-type-title").textContent = currentType.title;
  document.querySelector(".battery-type-description").textContent = currentType.description;

  const imageElement = document.querySelector(".battery-type-image");
  if (imageElement) {


    imageElement.textContent = "";


    imageElement.style.backgroundImage = `url('${currentType.image}')`;
    imageElement.style.backgroundSize = "cover";
    imageElement.style.backgroundPosition = "center";
    imageElement.style.backgroundRepeat = "no-repeat";

    imageElement.style.animation = "fadeInOut 0.5s ease-in-out";
    setTimeout(() => (imageElement.style.animation = ""), 500);
  }
}


function cycleNextBatteryType() {
  currentBatteryIndex = (currentBatteryIndex + 1) % batteryTypes.length;
  updateBatteryType();
}

function cyclePrevBatteryType() {
  currentBatteryIndex =
    (currentBatteryIndex - 1 + batteryTypes.length) % batteryTypes.length;
  updateBatteryType();
}

updateBatteryType();

function updateButtonStates() {
  const prevBtn = document.querySelector(".btn-prev");
  const nextBtn = document.querySelector(".btn-next");

  if (!prevBtn || !nextBtn) return;

  prevBtn.disabled = currentBatteryIndex === 0;
  nextBtn.disabled = currentBatteryIndex === batteryTypes.length - 1;

  prevBtn.style.opacity = prevBtn.disabled ? "0.5" : "1";
  nextBtn.style.opacity = nextBtn.disabled ? "0.5" : "1";

  prevBtn.style.cursor = prevBtn.disabled ? "not-allowed" : "pointer";
  nextBtn.style.cursor = nextBtn.disabled ? "not-allowed" : "pointer";
}

function cycleNextBatteryType() {
  if (currentBatteryIndex < batteryTypes.length - 1) {
    currentBatteryIndex++;
    updateBatteryType();
    updateButtonStates();
    equalizeInfoBoxHeights();
  }
}

function cyclePrevBatteryType() {
  if (currentBatteryIndex > 0) {
    currentBatteryIndex--;
    updateBatteryType();
    updateButtonStates();
    equalizeInfoBoxHeights();
  }
}

function equalizeInfoBoxHeights() {
  const boxes = document.querySelectorAll(".battery-info-box");
  if (!boxes.length) return;

  boxes.forEach(box => (box.style.height = "auto"));

  let maxHeight = 0;
  boxes.forEach(box => {
    const height = box.offsetHeight;
    if (height > maxHeight) maxHeight = height;
  });


  boxes.forEach(box => (box.style.height = maxHeight + "px"));
}


document.addEventListener("DOMContentLoaded", () => {
  updateBatteryType();
  updateButtonStates();
  equalizeInfoBoxHeights();
});


window.addEventListener("resize", () => {
  equalizeInfoBoxHeights();
});


window.cycleNextBatteryType = cycleNextBatteryType;
window.cyclePrevBatteryType = cyclePrevBatteryType;


function openContactModal(event) {
  if (event) event.preventDefault(); 
  const modal = document.getElementById("contactModal");
  if (modal) {
    modal.style.display = "flex";
    document.body.style.overflow = "hidden"; 
  }
}

function closeContactModal() {
  const modal = document.getElementById("contactModal");
  if (modal) {
    modal.style.display = "none";
    document.body.style.overflow = "auto";
  }
}


window.addEventListener("click", function (event) {
  const modal = document.getElementById("contactModal");
  if (modal && event.target === modal) {
    closeContactModal();
  }
});

window.openContactModal = openContactModal;
window.closeContactModal = closeContactModal;
window.handleLocateSubmit = handleLocateSubmit;
window.cycleNextBatteryType = cycleNextBatteryType;
window.cyclePrevBatteryType = cyclePrevBatteryType;
window.drawAllStationsMap = drawAllStationsMap; 
window.updateStationTime = updateStationTime; 
window.handleLocationModeToggle = handleLocationModeToggle;


function handleContactSubmit(event) {
    event.preventDefault(); 

    alert("Thank you! Your message has been sent successfully.");


    document.getElementById("contactForm").reset();

    closeContactModal();
}

window.handleContactSubmit = handleContactSubmit;