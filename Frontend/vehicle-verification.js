const vehicleFields = [
    { id: "firmware-vin", key: "e3VehicleVin", label: "VIN" },
    { id: "firmware-registration", key: "e3VehicleRegistration", label: "registration" },
    { id: "firmware-mobile", key: "e3VehicleMobile", label: "mobile number" },
    { id: "firmware-variant", key: "e3VehicleVariant", label: "variant" }
];
const vehicleForm = document.getElementById("vehicle-details-form");

for (const { id, key } of vehicleFields) {
    const field = document.getElementById(id);
    const savedValue = localStorage.getItem(key);
    if (savedValue !== null) field.value = savedValue;
    field.addEventListener("input", () => field.setCustomValidity(""));
    field.addEventListener("change", () => field.setCustomValidity(""));
}

vehicleForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const details = vehicleFields.map(({ id, key, label }) => ({
        field: document.getElementById(id),
        key,
        label,
        value: document.getElementById(id).value.trim()
    }));
    for (const { field } of details) field.setCustomValidity("");

    const missing = details.find(({ value }) => !value);
    if (missing) {
        missing.field.setCustomValidity(`Please enter the ${missing.label}.`);
        missing.field.reportValidity();
        return;
    }

    try {
        for (const { field, key, value } of details) {
            localStorage.setItem(key, value);
        }
        localStorage.setItem("e3AutoVerifyFirmware", "true");
    } catch {
        const vinField = document.getElementById("firmware-vin");
        vinField.setCustomValidity("Unable to save vehicle details. Please enable local storage and try again.");
        vinField.reportValidity();
        return;
    }

    window.location.assign("/dashboard");
});
