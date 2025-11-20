# app.py - Fixed & Hardened version for Suprit's EV locator
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import pickle
import pandas as pd
from geopy.distance import geodesic
import numpy as np
import re
import os
import time
import unicodedata
from geopy.geocoders import Nominatim

app = Flask(__name__, static_folder='.', static_url_path='')
CORS(app)

# ----------------------------
# Configuration / Constants
# ----------------------------
LOCAL_SEARCH_DISTANCE_KM = 25
MAX_CROSS_REGION_SUGGESTION_KM = 300
INDIA_BOUNDS = (6.0, 68.0, 36.0, 98.0)
DEFAULT_KNN_NEIGHBORS = 10

ALL_INDIAN_STATES_UTS = [
    "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa",
    "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala",
    "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland",
    "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
    "Uttar Pradesh", "Uttarakhand", "West Bengal",
    "Andaman and Nicobar Islands", "Chandigarh", "Dadra and Nagar Haveli and Daman and Diu",
    "Delhi", "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry"
]

# ----------------------------
# Globals (populated on start)
# ----------------------------
model = None   # KNN model object (from pickle)
df = None      # station dataframe (from pickle saved df used in model)
ev_df = None   # final_clean_ev_stations_polygon.csv dataframe (used as master station source)
full_cities_geo_df = pd.DataFrame()  # Indian_cities.csv (City, State, Latitude, Longitude)
location_map = {}  # { state: [cities...] }

# ----------------------------
# Utility helpers
# ----------------------------
def clean_state_name(name):
    """Normalize and title-case a state name safely."""
    if pd.isna(name) or name is None:
        return ""
    s = str(name).strip()
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('utf-8')
    s = re.sub(r'[^\w\s]', '', s).strip()
    return s.title()

def clean_city_name(name):
    if pd.isna(name) or name is None:
        return ""
    return str(name).strip().title()

def safe_float(x):
    try:
        return float(x)
    except Exception:
        return None

# ----------------------------
# Load model & datasets
# ----------------------------
try:
    # Attempt load of the knn model + df (as you had)
    if os.path.exists("data/knn_ev_model.pkl"):
        model, df = pickle.load(open("data/knn_ev_model.pkl", "rb"))
        # Ensure df has required columns and normalized form for display/search
        df['latitude'] = pd.to_numeric(df['latitude'], errors='coerce')
        df['longitude'] = pd.to_numeric(df['longitude'], errors='coerce')
        df['name'] = df['name'].astype(str).fillna('Unknown Station')
        df['address'] = df['address'].astype(str).fillna('Unknown Address')
        df['state'] = df['state'].astype(str).str.strip().str.title()
        df['city'] = df['city'].astype(str).str.strip().str.title()
    else:
        print("WARNING: data/knn_ev_model.pkl not found. /recommend endpoint may not work until model is created.")

    # Also load the final cleaned EV stations CSV (this is the authoritative station list)
    if os.path.exists("final_clean_ev_stations_polygon.csv"):
        ev_df = pd.read_csv("final_clean_ev_stations_polygon.csv", low_memory=False)
        ev_df['state'] = ev_df['state'].astype(str).str.strip().str.title()
        ev_df['city'] = ev_df['city'].astype(str).str.strip().str.title()
        ev_df['latitude'] = pd.to_numeric(ev_df['latitude'], errors='coerce')
        ev_df['longitude'] = pd.to_numeric(ev_df['longitude'], errors='coerce')
    else:
        print("WARNING: final_clean_ev_stations_polygon.csv not found. Using model dataframe if available.")

    # Load city list used for dropdowns (Indian_cities.csv). THIS uses 'City' and 'State' columns
    if os.path.exists("Indian_cities.csv"):
        full_cities_geo_df = pd.read_csv("Indian_cities.csv", low_memory=False)
        # Standardize column names that we expect (but do NOT force lower-case keys)
        # Expected: City, State, Latitude, Longitude
        if 'City' not in full_cities_geo_df.columns or 'State' not in full_cities_geo_df.columns:
            # try case-insensitive fallback mapping
            cols = {c.lower(): c for c in full_cities_geo_df.columns}
            if 'city' in cols and 'state' in cols:
                full_cities_geo_df = full_cities_geo_df.rename(columns={cols['city']: 'City', cols['state']: 'State'})
            else:
                # last resort: print and keep as-is. We'll gracefully fallback later.
                print("Indian_cities.csv columns are unexpected:", full_cities_geo_df.columns.tolist())
        # Normalize City/State casing for matching
        if 'City' in full_cities_geo_df.columns:
            full_cities_geo_df['City'] = full_cities_geo_df['City'].astype(str).str.strip().str.title()
        if 'State' in full_cities_geo_df.columns:
            full_cities_geo_df['State'] = full_cities_geo_df['State'].astype(str).str.strip().str.title()
        if 'Latitude' in full_cities_geo_df.columns:
            full_cities_geo_df['Latitude'] = pd.to_numeric(full_cities_geo_df['Latitude'], errors='coerce')
        if 'Longitude' in full_cities_geo_df.columns:
            full_cities_geo_df['Longitude'] = pd.to_numeric(full_cities_geo_df['Longitude'], errors='coerce')
    else:
        print("Indian_cities.csv not found. Dropdowns will use EV dataset as fallback.")

    # Build the dropdown location_map (authoritative list of states -> city lists)
    location_map = {}
    # Precreate all states so front-end gets keys always
    for s in ALL_INDIAN_STATES_UTS:
        location_map[s] = []

    # Primary source for dropdown: Indian_cities.csv (if properly loaded)
    if not full_cities_geo_df.empty and 'City' in full_cities_geo_df.columns and 'State' in full_cities_geo_df.columns:
        for state in ALL_INDIAN_STATES_UTS:
            # match by Title-case state (consistent with ALL_INDIAN_STATES_UTS)
            cities = full_cities_geo_df.loc[full_cities_geo_df['State'] == state, 'City'].unique().tolist()
            if cities and len(cities) > 0:
                location_map[state] = sorted([clean_city_name(c) for c in cities])
    # Fallback: populate missing states with cities from the EV master dataset
    # (This ensures Bihar/Assam won't be empty even if Indian_cities.csv is partial)
    if ev_df is not None:
        for state in ALL_INDIAN_STATES_UTS:
            if not location_map.get(state):
                # Extract unique station cities for that state
                cities = ev_df.loc[ev_df['state'] == state, 'city'].dropna().unique().tolist()
                if cities and len(cities) > 0:
                    location_map[state] = sorted([clean_city_name(c) for c in cities])

    # Final defensive check: ensure every state key exists (even if empty list)
    for s in ALL_INDIAN_STATES_UTS:
        if s not in location_map:
            location_map[s] = []

except Exception as e:
    print("FATAL ERROR during startup load:", e)
    # Ensure location_map has keys so front-end doesn't break
    location_map = {state: [] for state in ALL_INDIAN_STATES_UTS}

# ----------------------------
# Static file serving
# ----------------------------
@app.route('/')
def index():
    return send_from_directory(app.root_path, 'locate.html')

@app.route('/<path:filename>')
def serve_static(filename):
    return send_from_directory(app.root_path, filename)

# ----------------------------
# Locations endpoint (dropdown)
# ----------------------------
@app.route('/locations', methods=['GET'])
def get_locations():
    """
    Returns:
      {
        "states": [...],
        "cities_by_state": { state: [cities...] }
      }
    Primary source: Indian_cities.csv (City/State). If a state has no cities there,
    we fallback to final_clean_ev_stations_polygon.csv (ev_df).
    """
    try:
        return jsonify({'states': sorted(ALL_INDIAN_STATES_UTS), 'cities_by_state': location_map})
    except Exception as e:
        print("Error in /locations:", e)
        return jsonify({'states': sorted(ALL_INDIAN_STATES_UTS), 'cities_by_state': {s: [] for s in ALL_INDIAN_STATES_UTS}})

# ----------------------------
# Helper: lookup city coordinates from Indian_cities.csv (fast)
# ----------------------------
def get_city_coordinates_from_file(city, state):
    """
    Attempt to fetch coordinates from Indian_cities.csv (City, State, Latitude, Longitude).
    Returns (lat, lon) or (None, None)
    """
    if full_cities_geo_df.empty:
        return None, None

    city_q = clean_city_name(city)
    state_q = clean_state_name(state)

    # 1) Try exact match City + State
    try:
        m = full_cities_geo_df[
            (full_cities_geo_df['City'] == city_q) &
            (full_cities_geo_df['State'] == state_q)
        ]
        if not m.empty:
            lat = safe_float(m.iloc[0].get('Latitude'))
            lon = safe_float(m.iloc[0].get('Longitude'))
            if lat is not None and lon is not None:
                return lat, lon
    except Exception:
        # if columns mismatched or other problem - return None, None
        pass

    return None, None

# ----------------------------
# Geocode helper (primary local CSV -> nominatim fallback -> state center)
# ----------------------------
def geocode_location(city, state=None, area=None):
    """
    Return lat, lon for the provided city,state,area. Uses:
      1) get_city_coordinates_from_file (fast, offline)
      2) Nominatim geocoding for city,state
      3) Nominatim geocode of state center
      4) Area refinement if area provided
    """
    lat = lon = None

    # 1. City-level CSV lookup
    if city and str(city).strip() != '':
        lat, lon = get_city_coordinates_from_file(city, state)
        if lat is None or lon is None:
            # fallback to nominatim
            try:
                geolocator = Nominatim(user_agent="ev_locator")
                query = f"{city}, {state or ''}, India"
                loc = geolocator.geocode(query, timeout=10)
                if loc:
                    lat, lon = loc.latitude, loc.longitude
                    time.sleep(1)  # gentle rate limit
            except Exception as e:
                print("Nominatim fallback error (city):", e)

    # 2. If still not found, use state center via Nominatim
    if (lat is None or lon is None) and state:
        try:
            geolocator_state = Nominatim(user_agent="ev_locator")
            query = f"{state}, India"
            loc = geolocator_state.geocode(query, timeout=10)
            if loc:
                lat, lon = loc.latitude, loc.longitude
                time.sleep(1)
        except Exception as e:
            print("Nominatim state fallback error:", e)
            return None, None

    # 3. Area refinement
    if (lat is not None and lon is not None) and area and re.search(r'[a-zA-Z0-9]', area):
        try:
            geolocator_refine = Nominatim(user_agent="ev_locator")
            query = f"{area}, {city or ''}, {state or ''}, India"
            loc = geolocator_refine.geocode(query, timeout=10)
            if loc:
                return loc.latitude, loc.longitude
            else:
                return lat, lon
        except Exception as e:
            print("Nominatim area refinement error:", e)
            return lat, lon

    # 4. Validate within India bounds
    if lat is not None and lon is not None:
        if not (INDIA_BOUNDS[0] <= lat <= INDIA_BOUNDS[2] and INDIA_BOUNDS[1] <= lon <= INDIA_BOUNDS[3]):
            return None, None

    return lat, lon

# ----------------------------
# Recommend endpoint
# ----------------------------
@app.route('/recommend', methods=['POST'])
@app.route('/recommend/', methods=['POST'])
def recommend():
    try:
        data = request.get_json() or {}

        user_lat = data.get('latitude')
        user_lon = data.get('longitude')

        lat = lon = None
        user_location_name = "your location"

        if user_lat is not None and user_lon is not None:
            try:
                lat = float(user_lat)
                lon = float(user_lon)
                state_for_check = None
            except Exception:
                return jsonify({'error': 'Invalid latitude or longitude provided.'})
        else:
            # manual lookup (state is required)
            state = (data.get('state') or '').strip().title()
            city = (data.get('city') or '').strip().title()
            area = (data.get('area') or '').strip().title()

            if not state:
                return jsonify({'error': 'State is a required field.'})

            lat, lon = geocode_location(city, state, area)
            user_location_name = city if city else state
            state_for_check = state

        if not lat or not lon:
            return jsonify({'error': f'Unable to determine a location for \"{user_location_name}\". Please try a different selection.'})

        origin_lat = lat
        origin_lon = lon

        if model is None or (df is None and ev_df is None):
            return jsonify({'error': 'Server configuration error. Model or data not loaded.'})

        # Use df if model exists; otherwise try ev_df
        search_df = df if df is not None else ev_df

        # Prepare user coords in radians for haversine KNN model if available
        user_coords_rad = np.radians([[lat, lon]])

        try:
            # Request more neighbors than we will return so fallback options exist
            kneighbors = max(DEFAULT_KNN_NEIGHBORS, 5)
            distances, indices = model.kneighbors(user_coords_rad, n_neighbors=kneighbors)
            valid_indices = [int(i) for i in indices[0] if not pd.isna(search_df.loc[int(i), 'latitude']) and not pd.isna(search_df.loc[int(i), 'longitude'])]
            if not valid_indices:
                return jsonify({'error': f'The nearest stations found around {user_location_name} had incomplete location data. Try a different area.'})
            recommendations_df = search_df.iloc[valid_indices]
        except Exception as knn_error:
            print("KNN/Data retrieval error:", knn_error)
            # As a defensive fallback: compute distances to all EV stations (if ev_df available)
            if ev_df is not None:
                all_rows = ev_df.copy()
                all_rows['distance'] = all_rows.apply(lambda r: round(geodesic((lat, lon), (r['latitude'], r['longitude'])).km, 2) if not pd.isna(r['latitude']) and not pd.isna(r['longitude']) else np.inf, axis=1)
                recommendations_df = all_rows.sort_values('distance').head(DEFAULT_KNN_NEIGHBORS)
            else:
                return jsonify({'error': 'A data processing error occurred. Please try a different location.'})

        # Hybrid search: find local results within LOCAL_SEARCH_DISTANCE_KM
        local_results = []
        for idx, row in recommendations_df.iterrows():
            if pd.isna(row['latitude']) or pd.isna(row['longitude']):
                continue
            try:
                dist_km = round(geodesic((lat, lon), (row['latitude'], row['longitude'])).km, 2)
            except Exception:
                continue
            if dist_km <= LOCAL_SEARCH_DISTANCE_KM:
                local_results.append({
                    'station_name': row['name'],
                    'address': row.get('address', ''),
                    'distance': dist_km,
                    'latitude': row['latitude'],
                    'longitude': row['longitude']
                })

        # Deduplicate based on name+address
        def dedupe_list(results):
            unique = []
            seen = set()
            for r in results:
                key = (r['station_name'].strip().lower(), r['address'].strip().lower())
                if key not in seen:
                    seen.add(key)
                    unique.append(r)
            return unique

        if local_results:
            unique_results = dedupe_list(local_results)
            return jsonify({
                'recommendations': unique_results,
                'origin_latitude': origin_lat,
                'origin_longitude': origin_lon
            })

        # If no local results, fallback to nearest stations (within MAX_CROSS_REGION_SUGGESTION_KM)
        fallback_list = []
        for _, row in recommendations_df.iterrows():
            if pd.isna(row['latitude']) or pd.isna(row['longitude']):
                continue
            try:
                dkm = round(geodesic((lat, lon), (row['latitude'], row['longitude'])).km, 2)
            except Exception:
                continue
            if dkm <= MAX_CROSS_REGION_SUGGESTION_KM:
                fallback_list.append({
                    'station_name': row['name'],
                    'address': row.get('address', ''),
                    'distance': dkm,
                    'latitude': row['latitude'],
                    'longitude': row['longitude'],
                    'state': row.get('state', ''),
                    'city': row.get('city', '')
                })

        fallback_list.sort(key=lambda x: x['distance'])
        final_fallback_recommendations = fallback_list[:5]

        if not final_fallback_recommendations:
            return jsonify({
                'error': f'No charging stations found within {MAX_CROSS_REGION_SUGGESTION_KM} km of the entered location.',
                'origin_latitude': origin_lat,
                'origin_longitude': origin_lon
            })

        nearest_station_for_message = final_fallback_recommendations[0]
        nearest_dist_km = nearest_station_for_message['distance']
        nearest_station_city = nearest_station_for_message.get('city', '')
        nearest_station_state = nearest_station_for_message.get('state', '')

        # Defensive address-based correction for state name in messages
        address_lower = nearest_station_for_message.get('address', '').lower()
        if any(x in address_lower for x in ['kashmir', 'jammu', 'katra', 'vaishno devi', 'vaishnodevi']):
            nearest_station_state = "Jammu and Kashmir"
        elif any(x in address_lower for x in ['delhi', 'noida', 'gurgaon', 'gurugram']):
            nearest_station_state = "Delhi"

        error_message = (
            f"No stations found locally near {user_location_name}. "
            f"The nearest station is in {nearest_station_city} in {nearest_station_state}, "
            f"{nearest_dist_km} km away."
)

        return jsonify({
            'error': error_message,
            'recommendations': final_fallback_recommendations,
            'origin_latitude': origin_lat,
            'origin_longitude': origin_lon
        })

    except Exception as e:
        print("CRITICAL UNHANDLED ERROR IN /recommend:", e)
        return jsonify({'error': 'An unexpected server error occurred. Please try again or check the server console.'})

# ----------------------------
# Run
# ----------------------------
if __name__ == '__main__':
    # For local dev. Use appropriate host/port in production.
    app.run(host='0.0.0.0', port=8000, debug=False, use_reloader=False)
