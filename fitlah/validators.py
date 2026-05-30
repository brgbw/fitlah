def nric_check(ic):
    if not isinstance(ic, str):
        return False

    ic = ic.upper().strip()

    if len(ic) != 9:
        return False

    prefix = ic[0]
    digits = ic[1:8]
    suffix = ic[8]

    if prefix not in {"S", "T", "F", "G"}:
        return False

    if not digits.isdigit():
        return False

    weights = [2, 7, 6, 5, 4, 3, 2]

    total = sum(int(digit) * weight for digit, weight in zip(digits, weights))

    # Add 4 only for T and G series
    if prefix in {"T", "G"}:
        total += 4

    if prefix in {"S", "T"}:
        checksum_letters = "JZIHGFEDCBA"
    else:  # F or G
        checksum_letters = "XWUTRQPNMLK"

    return suffix == checksum_letters[total % 11]